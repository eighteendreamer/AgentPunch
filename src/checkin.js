import { chromium } from "patchright";

export class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const GITHUB_CLIENT_ID = "Ov23lidtiR4LeVZvVRNL";

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

async function ensureGithubOAuth(page, baseUrl, log) {
  await gotoWithRetry(page, `${baseUrl}/login`);
  const stateResponse = await withRetry(() => getJson(page, "/api/oauth/state?mode=login"));
  if (!stateResponse.ok || !stateResponse.body?.success || !stateResponse.body?.data) {
    throw new Error(`无法获取 OAuth state：${stateResponse.body?.message || stateResponse.status}`);
  }

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("state", stateResponse.body.data);
  authorizeUrl.searchParams.set("scope", "user:email");
  const oauthResponsePromise = page
    .waitForResponse((response) => response.url().includes("/api/oauth/github?"), { timeout: 60_000 })
    .catch(() => null);
  let capturedCallbackUrl = null;
  const mainDomainCallback = "https://agentrouter.org/oauth/github**";
  await page.route(mainDomainCallback, async (route) => {
    capturedCallbackUrl = route.request().url();
    await route.abort();
  });
  log("info", "oauth_start", "开始 GitHub OAuth 授权");
  await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
    if (!capturedCallbackUrl) throw error;
  });

  if (page.url().startsWith("https://github.com/login")) {
    throw new AuthRequiredError("GitHub 登录态已失效，请运行 npm run setup 重新登录");
  }

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
  await page.unroute(mainDomainCallback);
  if (!capturedCallbackUrl) throw new Error("未捕获到 GitHub OAuth 回调地址");

  const domesticCallback = new URL("/oauth/github", baseUrl);
  domesticCallback.search = new URL(capturedCallbackUrl).search;
  log("info", "oauth_callback_rewritten", "已将 OAuth 回调切换到国内可访问域名");
  await gotoWithRetry(page, domesticCallback.href, 60_000);
  await page.waitForURL((url) => url.origin === baseUrl && url.pathname.startsWith("/console"), {
    timeout: 60_000,
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("domcontentloaded");

  const oauthResponse = await oauthResponsePromise;
  const oauthBody = oauthResponse ? await oauthResponse.json().catch(() => null) : null;
  if (oauthBody?.success && oauthBody.data) return oauthBody.data;

  const localUser = await page
    .evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("user"));
      } catch {
        return null;
      }
    })
    .catch(() => null);
  const self = await withRetry(() =>
    getJson(page, "/api/user/self", {
      headers: localUser?.id ? { "New-API-User": String(localUser.id) } : {},
    }),
  );
  if (!self.ok || !self.body?.success) {
    throw new Error(`OAuth 回调后无法读取账户：${self.body?.message || self.status}`);
  }
  return { ...self.body.data, checked_in: localUser?.checked_in ?? self.body.data?.checked_in };
}

export async function runCheckin({ profileDir, baseUrl, headless, log }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await clearAgentRouterState(context, page, [baseUrl], log);
    const user = await ensureGithubOAuth(page, baseUrl, log);
    return {
      checkedIn: Boolean(user?.checked_in),
      userId: user?.id ?? null,
      username: user?.username ?? null,
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
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://github.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  return { context, page, baseUrl };
}
