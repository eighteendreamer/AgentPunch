import { chromium } from "patchright";

export class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const GITHUB_CLIENT_ID = "Ov23lidtiR4LeVZvVRNL";

// ---------------------------------------------------------------------------
// 站点注册表 —— 每个公益站是一个独立的签到模块
// 每个模块导出 { id, name, run(context, page, githubCookies, log) }
// run 抛出 AuthRequiredError 表示 GitHub 登录态失效（会终止所有站点）
// run 抛出其他错误仅影响当前站点
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 站点 1: AgentRouter (ps.air-outer.com)
// ---------------------------------------------------------------------------

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

async function clearSiteState(context, page, origin, log, options = {}) {
  const { logoutApi = null, siteLabel = origin } = options;
  try {
    await gotoWithRetry(page, origin);
    if (logoutApi) {
      const logout = await getJson(page, logoutApi);
      log("info", "logout", `${siteLabel} 登出请求已完成`, { status: logout.status, success: logout.body?.success });
    }
  } catch (error) {
    log("warn", "logout", `${siteLabel} 原会话可能已失效，继续清理`, { error: error.message });
  }
  await page
    .evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    })
    .catch(() => {});
  const hostname = new URL(origin).hostname.replaceAll(".", "\\.");
  await context.clearCookies({ domain: new RegExp(`(^|\\.)${hostname}$`) });
  log("info", "state_cleared", `${siteLabel} 的 Cookie 和 Web Storage 已清理`);
}

async function ensureAgentRouterLogin(context, page, baseUrl, log) {
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
    throw new AuthRequiredError("GitHub 登录态已失效，请在设置页点击\u201c切换账号\u201d重新绑定");
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

// ---------------------------------------------------------------------------
// 站点 2: JustDoWork (api.justwoker.icu)
// ---------------------------------------------------------------------------

const JUSTWOKER_BASE_URL = "https://api.justwoker.icu";

async function readJustWokerBalance(page) {
  // 先主动刷新 JWT token（JustDoWork 使用 refresh cookie 换取新 access_token）
  await page.evaluate(async () => {
    try {
      const resp = await fetch("/api/user/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const data = await resp.json();
      if (data?.success && data?.data?.access_token) {
        // 保存到 localStorage，后续请求使用
        localStorage.setItem("token", JSON.stringify({ access_token: data.data.access_token }));
      }
    } catch {}
  });

  const result = await page.evaluate(async () => {
    // JustDoWork 使用 JWT Bearer token，存储在 localStorage
    let accessToken = null;
    try {
      accessToken = JSON.parse(localStorage.getItem("token"))?.access_token || null;
    } catch {}
    // 兜底：有些版本直接存字符串
    if (!accessToken) {
      accessToken = localStorage.getItem("access_token") || null;
    }

    const headers = {
      Accept: "application/json",
      "Cache-Control": "no-store",
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    const [statusResponse, userResponse] = await Promise.all([
      fetch("/api/status", { credentials: "include", headers }).then((r) => r.json()),
      fetch("/api/user/self", { credentials: "include", headers }).then((r) => r.json()),
    ]);

    if (!userResponse?.success) return { error: userResponse?.message || "AUTH_REQUIRED" };

    return {
      quota: Number(userResponse.data?.quota || 0),
      usedQuota: Number(userResponse.data?.used_quota || 0),
      requestCount: Number(userResponse.data?.request_count || 0),
      quotaPerUnit: Number(statusResponse?.data?.quota_per_unit || 500000),
      displayInCurrency: statusResponse?.data?.display_in_currency !== false,
    };
  });

  if (result?.error) throw new AuthRequiredError("JustDoWork 登录态已失效，请重新绑定 GitHub");
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

async function ensureJustWokerCheckin(context, page, log) {
  log("info", "justwoker_start", "开始 JustDoWork 公益站签到流程");

  await gotoWithRetry(page, `${JUSTWOKER_BASE_URL}/sign-in`);
  log("info", "justwoker_signin_page", "已加载 JustDoWork 登录页面");

  const currentUrl = page.url();
  if (currentUrl.includes("/dashboard")) {
    log("info", "justwoker_already_logged_in", "已检测到 JustDoWork 登录态，直接进入控制台");
  } else {
    const githubButton = page.locator('button:has-text("GitHub")');
    await githubButton.first().click({ timeout: 10_000 });
    log("info", "justwoker_github_click", "已点击 GitHub 登录按钮");

    await page.waitForURL(/\/dashboard\/overview|\/sign-in/, { timeout: 60_000 }).catch(() => {});

    if (page.url().includes("/sign-in")) {
      log("warn", "justwoker_auth_pending", "GitHub OAuth 授权可能需要确认");
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 }).catch(() => {});
    }
  }

  if (!page.url().includes("/dashboard")) {
    await gotoWithRetry(page, `${JUSTWOKER_BASE_URL}/dashboard/overview`, 60_000);
  }

  log("info", "justwoker_dashboard_loaded", "已进入 JustDoWork 控制台，签到自动触发");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 读取余额
  const balance = await readJustWokerBalance(page).catch((error) => {
    log("warn", "justwoker_balance_failed", `JustDoWork 余额读取失败：${error.message}`, { error: error.message });
    return null;
  });
  if (balance) log("info", "justwoker_balance", `JustDoWork 余额已更新：${balance.currency}${balance.balance.toFixed(2)}`);

  try {
    await gotoWithRetry(page, `${JUSTWOKER_BASE_URL}/usage-logs/common`, 60_000);
    const logText = await page.evaluate(() => document.body.innerText);
    const hasCheckinLog = /用户签到|签到成功|获得额度/.test(logText);
    log("info", "justwoker_verify", hasCheckinLog ? "JustDoWork 签到验证成功（日志中包含签到记录）" : "JustDoWork 签到验证完成（未在当前页找到签到记录，可能今日已签到）", { hasCheckinLog });
    return { checkedIn: hasCheckinLog, site: "justwoker", balance };
  } catch (error) {
    log("warn", "justwoker_verify_failed", `JustDoWork 签到验证失败：${error.message}`, { error: error.message });
    return { checkedIn: true, site: "justwoker", balance, warning: "签到可能已成功，但验证失败" };
  }
}

// ---------------------------------------------------------------------------
// 站点注册表
// ---------------------------------------------------------------------------

const SITES = [
  {
    id: "agentrouter",
    name: "AgentRouter",
    origins: [process.env.AGENT_ROUTER_BASE_URL?.replace(/\/$/, "") || "https://ps.air-outer.com"],
    async run({ context, page, githubCookies, baseUrl, log }) {
      const origin = baseUrl.replace(/\/$/, "");
      await clearSiteState(context, page, origin, log, { logoutApi: "/api/user/logout", siteLabel: "AgentRouter" });
      const user = await ensureAgentRouterLogin(context, page, origin, log);
      const balance = await readAccountBalance(page, user).catch((error) => {
        log("warn", "balance", "AgentRouter 签到完成，但余额快照暂时无法更新", { error: error.message });
        return null;
      });
      return {
        checkedIn: Boolean(user?.checked_in),
        userId: user?.id ?? null,
        username: user?.username ?? null,
        balance,
      };
    },
  },
  {
    id: "justwoker",
    name: "JustDoWork",
    origins: ["https://api.justwoker.icu"],
    async run({ context, page, log }) {
      // 清理旧状态（不调用 logout API，只清理 cookie/storage）
      await clearSiteState(context, page, JUSTWOKER_BASE_URL, log, { siteLabel: "JustDoWork" });
      return await ensureJustWokerCheckin(context, page, log);
    },
  },
];

// ---------------------------------------------------------------------------
// 多站点签到主函数
// ---------------------------------------------------------------------------

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

    const siteResults = [];
    let authFailed = false;

    for (const site of SITES) {
      if (authFailed) {
        siteResults.push({ site: site.id, name: site.name, status: "skipped", message: "GitHub 登录态已失效，已跳过" });
        continue;
      }

      // 为每个站点创建带 site 标识的 log 包装函数
      const siteLog = (level, event, message, details) => {
        log(level, event, message, details, site.id);
        console.log(`[${level}] [${site.name}] ${event}: ${message}`);
      };

      log("info", `site_${site.id}_start`, `开始 ${site.name} 签到`, null, site.id);
      try {
        const result = await site.run({ context, page, githubCookies, baseUrl, log: siteLog });
        siteResults.push({
          site: site.id,
          name: site.name,
          status: "success",
          checkedIn: result.checkedIn ?? false,
          message: result.checkedIn ? "签到成功" : "登录成功",
          data: result,
        });
        log("info", `site_${site.id}_success`, `${site.name} 签到完成`, null, site.id);
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          authFailed = true;
          siteResults.push({ site: site.id, name: site.name, status: "auth_required", message: error.message });
          log("error", `site_${site.id}_auth_required`, `${site.name}：${error.message}`, null, site.id);
        } else {
          siteResults.push({ site: site.id, name: site.name, status: "failure", message: error.message });
          log("error", `site_${site.id}_failed`, `${site.name} 签到失败：${error.message}`, { error: error.message }, site.id);
        }
      }
    }

    const refreshedGithubCookies = await context.cookies("https://github.com");

    // 汇总结果
    const agentRouterResult = siteResults.find((r) => r.site === "agentrouter");
    const anySuccess = siteResults.some((r) => r.status === "success");
    const allFailed = siteResults.every((r) => r.status === "failure" || r.status === "auth_required");

    return {
      // 向后兼容：AgentRouter 的字段仍然在顶层
      checkedIn: agentRouterResult?.data?.checkedIn ?? false,
      userId: agentRouterResult?.data?.userId ?? null,
      username: agentRouterResult?.data?.username ?? null,
      balance: agentRouterResult?.data?.balance ?? null,
      // 新增：多站点结果
      sites: siteResults,
      // 整体状态：只要有一个成功就算成功
      overallSuccess: anySuccess,
      overallStatus: authFailed ? "auth_required" : (allFailed ? "failure" : "success"),
      githubCookies: refreshedGithubCookies,
    };
  } finally {
    await context.close();
  }
}

export async function getAccountBalance({ profileDir, baseUrl, headless = true, githubCookies = [] }) {
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
    }

    const results = {};

    // AgentRouter 余额
    try {
      await gotoWithRetry(page, `${baseUrl}/console`, 60_000);
      const agentRouterBalance = await readAccountBalance(page);
      results.agentrouter = agentRouterBalance;
    } catch (error) {
      // AgentRouter 余额获取失败不阻塞 JustDoWork
    }

    // JustDoWork 余额
    try {
      // 尝试直接进入 dashboard，如果未登录则走 GitHub OAuth
      await gotoWithRetry(page, `${JUSTWOKER_BASE_URL}/dashboard/overview`, 60_000);
      if (page.url().includes("/sign-in")) {
        // 未登录，点击 GitHub 登录按钮
        const githubButton = page.locator('button:has-text("GitHub")');
        await githubButton.first().click({ timeout: 10_000 });
        await page.waitForURL(/\/dashboard/, { timeout: 60_000 }).catch(() => {});
      }
      if (page.url().includes("/dashboard")) {
        // 等待页面加载和自动刷新 token
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const justwokerBalance = await readJustWokerBalance(page);
        results.justwoker = justwokerBalance;
      } else {
        console.error("[balance] JustDoWork 未进入 dashboard，当前 URL:", page.url());
      }
    } catch (error) {
      console.error("[balance] JustDoWork 余额获取失败:", error.message);
    }

    // 返回多站点余额；向后兼容：如果有 agentrouter 余额也放到顶层
    return {
      agentrouter: results.agentrouter || null,
      justwoker: results.justwoker || null,
      // 向后兼容字段
      ...(results.agentrouter || {}),
    };
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
