import { chromium } from "patchright";

export class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const GITHUB_CLIENT_ID = "Ov23lidtiR4LeVZvVRNL";

function isAgentRouterCallback(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://agentrouter.org" && url.pathname === "/oauth/github";
  } catch {
    return false;
  }
}

function domesticSessionCookie(cookie, baseUrl) {
  if (!cookie || cookie.name !== "session") return null;
  const hostname = new URL(baseUrl).hostname;
  const { name, value, path: cookiePath, expires, httpOnly, secure, sameSite } = cookie;
  return { name, value, domain: hostname, path: cookiePath || "/", expires, httpOnly, secure, sameSite };
}

async function withRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    }
  }
  throw lastError;
}

async function gotoWithRetry(page, url, timeout = 45_000) {
  return withRetry(() => page.goto(url, { waitUntil: "domcontentloaded", timeout }));
}

function navigationErrorMessage(error, destination) {
  const message = String(error?.message || error || "");
  if (/ERR_CONNECTION_RESET/i.test(message)) {
    return `访问 ${destination} 时连接被重置，已自动重试 3 次，请检查网络后重试`;
  }
  if (/ERR_(?:CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED)|Timeout/i.test(message)) {
    return `访问 ${destination} 时网络连接不稳定，已自动重试 3 次，请检查网络后重试`;
  }
  return `访问 ${destination} 失败，请稍后重试`;
}

async function getJson(page, url, options = {}) {
  const result = await page.evaluate(
    async ({ requestUrl, requestOptions }) => {
      const response = await fetch(requestUrl, {
        credentials: "include",
        ...requestOptions,
        headers: { Accept: "application/json", ...(requestOptions.headers ?? {}) },
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { success: false, message: text.slice(0, 500) };
      }
      return { ok: response.ok, status: response.status, body };
    },
    { requestUrl: url, requestOptions: options },
  );
  return result;
}

async function clearAgentRouterState(context, page, origins, log) {
  for (const origin of origins) {
    try {
      await gotoWithRetry(page, origin);
      const logout = await getJson(page, "/api/user/logout");
      log("info", "logout", `站点登出请求已完成：${origin}`, {
        status: logout.status,
        success: logout.body?.success,
      });
    } catch (error) {
      log("warn", "logout", `站点原会话可能已失效，继续清理：${origin}`, { error: error.message });
    }

    await page
      .evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      })
      .catch(() => {});
    const hostname = new URL(origin).hostname.replaceAll(".", "\\.");
    await context.clearCookies({ domain: new RegExp(`(^|\\.)${hostname}$`) });
  }
  log("info", "state_cleared", `已清理 ${origins.join("、")} 的 Cookie 和 Web Storage`);
}

async function ensureGithubOAuth(context, page, baseUrl, log) {
  await gotoWithRetry(page, `${baseUrl}/login`);
  const stateResponse = await withRetry(() => getJson(page, "/api/oauth/state?mode=login"));
  if (!stateResponse.ok || !stateResponse.body?.success || !stateResponse.body?.data) {
    throw new Error(`无法获取 OAuth state：${stateResponse.body?.message || stateResponse.status}`);
  }

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("state", stateResponse.body.data);
  authorizeUrl.searchParams.set("scope", "user:email");
  const oauthResponsePromise = context
    .waitForEvent("response", {
      predicate: (response) => response.url().startsWith("https://agentrouter.org/api/oauth/github?"),
      timeout: 60_000,
    })
    .catch(() => null);
  let capturedCallbackUrl = null;
  const captureCallback = (url) => {
    if (!capturedCallbackUrl && isAgentRouterCallback(url)) {
      capturedCallbackUrl = url;
      log("info", "oauth_callback_captured", "已捕获 GitHub OAuth 回调，准备切换到国内域名");
    }
  };
  const requestListener = (request) => captureCallback(request.url());
  context.on("request", requestListener);
  const githubCookies = await context.cookies("https://github.com");
  const githubUsername = githubCookies.find((cookie) => cookie.name === "dotcom_user")?.value || null;
  const hasGithubSession = githubCookies.some((cookie) => cookie.name === "user_session" || cookie.name === "__Host-user_session_same_site");
  const cleanupOAuthCapture = async () => {
    context.off("request", requestListener);
  };
  log("info", "github_auth", hasGithubSession ? `检测到 GitHub 会话，正在在线验证${githubUsername ? `：@${githubUsername}` : ""}` : "正在验证 GitHub 登录态");
  log("info", "oauth_start", "开始 GitHub OAuth 授权");
  try {
    await withRetry(async () => {
      try {
        await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (error) {
        if (!capturedCallbackUrl) throw error;
      }
    });
  } catch (error) {
    await cleanupOAuthCapture();
    throw new Error(navigationErrorMessage(error, "GitHub OAuth"), { cause: error });
  }

  if (page.url().startsWith("https://github.com/login")) {
    await cleanupOAuthCapture();
    log("warn", "github_auth_required", "GitHub 登录态已失效，需要重新绑定账号");
    throw new AuthRequiredError("GitHub 登录态已失效，请在设置页点击“切换账号”重新绑定");
  }
  log("info", "github_auth_verified", `GitHub 在线登录验证通过${githubUsername ? `：@${githubUsername}` : ""}`);
  log("info", "github_oauth_page", "GitHub OAuth 授权页面已加载");

  const authorizeButton = page.locator(
    'button[name="authorize"], input[name="authorize"], button:has-text("Authorize"), button:has-text("授权")',
  );
  if (await authorizeButton.first().isVisible().catch(() => false)) {
    await authorizeButton
      .first()
      .click()
      .catch((error) => {
        if (!capturedCallbackUrl) throw error;
      });
    log("info", "oauth_authorized", "已确认 GitHub OAuth 授权");
  }

  const deadline = Date.now() + 60_000;
  while (!capturedCallbackUrl && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await cleanupOAuthCapture();
  if (!capturedCallbackUrl) {
    log("error", "oauth_callback_missing", "GitHub 授权已完成，但没有检测到 OAuth 回调请求");
    throw new Error("GitHub 授权后未检测到回调请求，请重新绑定账号后重试");
  }

  const oauthResponse = await oauthResponsePromise;
  const oauthBody = oauthResponse ? await oauthResponse.json().catch(() => null) : null;
  log("info", "oauth_api_response", "OAuth 接口响应已接收", {
    received: Boolean(oauthResponse),
    status: oauthResponse?.status() ?? null,
    success: oauthBody?.success ?? null,
    message: oauthBody?.message || null,
    hasData: Boolean(oauthBody?.data),
  });
  if (!oauthBody?.success || !oauthBody.data) {
    throw new Error(`GitHub OAuth 验证失败：${oauthBody?.message || "未收到有效响应"}`);
  }

  let mainSession = null;
  for (let attempt = 1; attempt <= 10 && !mainSession; attempt += 1) {
    mainSession = (await context.cookies("https://agentrouter.org")).find((cookie) => cookie.name === "session") || null;
    if (!mainSession) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const domesticCookie = domesticSessionCookie(mainSession, baseUrl);
  if (!domesticCookie) throw new Error("GitHub OAuth 已成功，但没有获取到 AgentRouter 会话");
  await context.addCookies([domesticCookie]);
  log("info", "oauth_session_synced", "已将 AgentRouter 会话安全同步到国内域名");

  await gotoWithRetry(page, `${baseUrl}/console`, 60_000);
  await page.evaluate((user) => localStorage.setItem("user", JSON.stringify(user)), oauthBody.data);
  log("info", "oauth_callback_complete", "AgentRouter OAuth 回调验证完成");
  log("info", "github_auth_complete", `GitHub 认证成功${githubUsername ? `：@${githubUsername}` : ""}`);
  return oauthBody.data;
}

async function readAccountBalance(page, knownUser = null) {
  const result = await page.evaluate(async (userFromOAuth) => {
    let localUser = userFromOAuth;
    if (!localUser?.id) {
      try {
        localUser = JSON.parse(localStorage.getItem("user"));
      } catch {
        localUser = null;
      }
    }
    if (!localUser?.id) return { error: "AUTH_REQUIRED" };

    const headers = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      "New-API-User": String(localUser.id),
    };
    const [statusResponse, userResponse] = await Promise.all([
      fetch("/api/status", { credentials: "include", headers }).then((response) => response.json()),
      fetch("/api/user/self", { credentials: "include", headers }).then((response) => response.json()),
    ]);
    if (!userResponse?.success) return { error: userResponse?.message || "AUTH_REQUIRED" };

    return {
      quota: Number(userResponse.data?.quota || 0),
      usedQuota: Number(userResponse.data?.used_quota || 0),
      requestCount: Number(userResponse.data?.request_count || 0),
      quotaPerUnit: Number(statusResponse?.data?.quota_per_unit || 500000),
      displayInCurrency: statusResponse?.data?.display_in_currency !== false,
    };
  }, knownUser);

  if (result?.error) throw new AuthRequiredError("站点登录态已失效，请重新绑定 GitHub");
  const divisor = result.quotaPerUnit > 0 ? result.quotaPerUnit : 500000;
  return {
    balance: result.quota / divisor,
    used: result.usedQuota / divisor,
    requestCount: result.requestCount,
    quotaPerUnit: divisor,
    currency: result.displayInCurrency ? "$" : "",
    updatedAt: new Date().toISOString(),
  };
}

export async function runCheckin({ profileDir, baseUrl, headless, log, githubCookies = [] }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    if (githubCookies.length) {
      await context.addCookies(githubCookies);
      log("info", "github_session_restored", "已从 Windows 安全存储恢复 GitHub 会话");
    }
    await clearAgentRouterState(context, page, [baseUrl], log);
    const user = await ensureGithubOAuth(context, page, baseUrl, log);
    const balance = await readAccountBalance(page, user).catch((error) => {
      log("warn", "balance", "签到完成，但余额快照暂时无法更新", { error: error.message });
      return null;
    });
    const refreshedGithubCookies = await context.cookies("https://github.com");
    return {
      checkedIn: Boolean(user?.checked_in),
      userId: user?.id ?? null,
      username: user?.username ?? null,
      balance,
      githubCookies: refreshedGithubCookies,
    };
  } finally {
    await context.close();
  }
}

export async function getAccountBalance({ profileDir, baseUrl, headless = true }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await gotoWithRetry(page, `${baseUrl}/console`, 60_000);
    return await readAccountBalance(page);
  } finally {
    await context.close();
  }
}

export async function interactiveSetup({ profileDir, baseUrl }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://github.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  return { context, page, baseUrl };
}

export const checkinInternals = { domesticSessionCookie, isAgentRouterCallback, navigationErrorMessage };
