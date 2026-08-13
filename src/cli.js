import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "patchright";
import { AuthRequiredError, getAccountBalance, interactiveSetup, runCheckin } from "./checkin.js";
import { CheckinDatabase } from "./db.js";
import { exportMigrationPackage, importMigrationPackage } from "./backup.js";
import { githubLoginPageSettled, githubSessionFromCookies, persistentGithubCookies, replaceBrowserProfile } from "./profile-binding.js";

const baseUrl = (process.env.AGENT_ROUTER_BASE_URL || "https://ps.air-outer.com").replace(/\/$/, "");
const dataDir = process.env.AGENT_ROUTER_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "AgentRouterCheckin");
const profileDir = path.join(dataDir, "browser-profile");
const pendingProfileDir = path.join(dataDir, "browser-profile.pending");
const previousProfileDir = path.join(dataDir, "browser-profile.previous");
const dbFile = path.join(dataDir, "checkin.sqlite3");
const accountFile = path.join(dataDir, "account.json");
const lockFile = path.join(dataDir, "run.lock");
const setupLockFile = path.join(dataDir, "setup.lock");

let initialSecretMessage = null;
try { initialSecretMessage = JSON.parse(fs.readFileSync(3, "utf8").trim()); }
catch {}

function readSecretMessage() {
  return initialSecretMessage;
}

function sendSecretMessage(payload) {
  try { fs.writeSync(4, `${JSON.stringify(payload)}\n`); }
  catch {}
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function acquireLock(filename = lockFile, conflictMessage = "已有签到进程正在运行") {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    return fs.openSync(filename, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - fs.statSync(filename).mtimeMs;
    if (age < 20 * 60_000) throw new Error(conflictMessage);
    fs.rmSync(filename, { force: true });
    return fs.openSync(filename, "wx");
  }
}

function releaseLock(fd, filename = lockFile) {
  try {
    fs.closeSync(fd);
  } finally {
    fs.rmSync(filename, { force: true });
  }
}

async function waitForRunLock(timeout = 3 * 60_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return acquireLock();
    } catch (error) {
      if (!error.message.includes("已有签到进程") || Date.now() >= deadline) {
        if (Date.now() >= deadline) throw new Error("等待签到或余额任务结束超时");
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function waitForGithubLogin(context, page, log = () => {}, timeout = 10 * 60_000) {
  const deadline = Date.now() + timeout;
  let candidateValue = null;
  let candidateSince = 0;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("GitHub 绑定窗口已关闭");
    const cookies = await context.cookies("https://github.com");
    const session = githubSessionFromCookies(cookies);
    const sessionCookie = cookies.find((cookie) => cookie.name === "user_session")?.value || null;
    if (session && githubLoginPageSettled(page.url())) {
      if (candidateValue !== sessionCookie) {
        candidateValue = sessionCookie;
        candidateSince = Date.now();
      }
      if (Date.now() - candidateSince >= 1_500) {
        try {
          const authenticatedDom = await page
            .locator('meta[name="user-login"]')
            .getAttribute("content")
            .catch(() => null);
          if (authenticatedDom) {
            await new Promise((resolve) => setTimeout(resolve, 750));
            const verifiedSession = githubSessionFromCookies(await context.cookies("https://github.com"));
            if (verifiedSession) {
              log("info", "github_login_verified", `GitHub 在线登录验证通过：@${authenticatedDom}`);
              return authenticatedDom || verifiedSession.username || session.username;
            }
          } else {
            log("warn", "github_login_pending", "GitHub 认证尚未完成，正在等待首页加载用户信息");
          }
        } catch {
          // 网络暂时不稳定时继续等待，避免把单次验证请求失败误判为登录失败。
        }
        candidateSince = Date.now();
      }
    } else {
      candidateValue = null;
      candidateSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("GitHub 登录尚未完成，请在登录窗口完成账号和 2FA 验证");
}

async function run() {
  const lock = acquireLock();
  const db = new CheckinDatabase(dbFile);
  let runId;
  try {
    const today = localDate();
    if (db.hasSuccessfulRun(today) && process.env.AGENT_ROUTER_FORCE !== "true") {
      console.log(`${today} 已成功执行过，跳过。`);
      return;
    }
    runId = db.beginRun(today);
    const log = (level, event, message, details) => {
      db.log(runId, level, event, message, details);
      console.log(`[${level}] ${event}: ${message}`);
    };
    const secret = readSecretMessage();
    const result = await runCheckin({
      profileDir,
      baseUrl,
      headless: process.env.AGENT_ROUTER_HEADLESS !== "false",
      log,
      githubCookies: secret?.type === "github-session" ? secret.cookies : [],
    });
    sendSecretMessage({ type: "github-session", cookies: persistentGithubCookies(result.githubCookies || []) });
    if (result.balance) db.saveAccountSnapshot(result.balance);
    const message = result.checkedIn ? "签到成功，新增额度已到账" : "登录成功，但站点未返回 checked_in=true";
    const { githubCookies: _githubCookies, ...publicResult } = result;
    db.finishRun(runId, { status: "success", checkedIn: result.checkedIn, message, details: publicResult });
    log("info", "complete", message, publicResult);
    console.log(message);
  } catch (error) {
    const status = error instanceof AuthRequiredError ? "auth_required" : "failure";
    if (runId) {
      db.finishRun(runId, { status, message: error.message });
      db.log(runId, "error", status, error.message, status === "auth_required" ? null : { stack: error.stack });
    }
    console.error(error.message);
    process.exitCode = status === "auth_required" ? 2 : 1;
  } finally {
    db.close();
    releaseLock(lock);
  }
}

async function balance() {
  const lock = acquireLock();
  const db = new CheckinDatabase(dbFile);
  try {
    const snapshot = await getAccountBalance({
      profileDir,
      baseUrl,
      headless: process.env.AGENT_ROUTER_HEADLESS !== "false",
    });
    db.saveAccountSnapshot(snapshot);
    console.log(JSON.stringify({
      balance: snapshot.balance,
      used: snapshot.used,
      requestCount: snapshot.requestCount,
      currency: snapshot.currency,
      updatedAt: snapshot.updatedAt,
    }));
  } catch (error) {
    console.error(error instanceof AuthRequiredError ? "需要重新绑定 GitHub 账号" : "余额更新失败");
    process.exitCode = error instanceof AuthRequiredError ? 2 : 1;
  } finally {
    db.close();
    releaseLock(lock);
  }
}

async function readPassword() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.replace(/\r?\n$/, "");
}

async function migration(mode, filename) {
  if (!filename) throw new Error("缺少迁移包文件路径");
  const lock = acquireLock();
  try {
    const password = await readPassword();
    const settings = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")); }
      catch { return {}; }
    })();
    const operation = mode === "export" ? exportMigrationPackage : importMigrationPackage;
    const secret = readSecretMessage();
    const result = await operation({
      dataDir,
      profileDir,
      [mode === "export" ? "outputFile" : "inputFile"]: path.resolve(filename),
      password,
      headless: settings.headless !== false,
      githubCookies: secret?.type === "github-session" ? secret.cookies : [],
    });
    if (mode === "import") {
      const db = new CheckinDatabase(dbFile);
      try {
        db.log(null, "info", "github_migration_verified", `迁移包 GitHub 登录状态在线验证通过${result.githubUsername ? `：@${result.githubUsername}` : ""}`);
      } finally {
        db.close();
      }
      sendSecretMessage({ type: "github-session", cookies: persistentGithubCookies(result.githubCookies || []) });
    }
    const { githubCookies: _githubCookies, ...publicResult } = result;
    console.log(JSON.stringify(publicResult));
  } catch (error) {
    console.error(error.message || "迁移操作失败");
    process.exitCode = 1;
  } finally {
    releaseLock(lock);
  }
}

async function setup() {
  fs.mkdirSync(dataDir, { recursive: true });
  const rl = readline.createInterface({ input, output });
  const { context, page } = await interactiveSetup({ profileDir, baseUrl });
  try {
    console.log("请在打开的 Chrome 窗口中完成 GitHub 登录与 2FA。不要使用第三方 2FA 网站；请用认证器或密码管理器本地生成验证码。");
    await rl.question("确认 GitHub 已登录后按 Enter：");
    await page.goto("https://github.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const session = githubSessionFromCookies(await context.cookies("https://github.com"));
    if (!session || page.url().startsWith("https://github.com/login")) {
      throw new AuthRequiredError("GitHub 仍未登录，请在设置页点击“切换账号”重新绑定");
    }
    console.log("GitHub 登录态已保存在独立 Chrome 配置中。现在执行一次站点签到验证……");
  } finally {
    await context.close();
    rl.close();
  }
  await run();
}

async function automaticSetup() {
  const setupLock = acquireLock(setupLockFile, "已有账号切换流程正在运行");
  let operationLock;
  let context;
  let setupDb;
  let committed = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    setupDb = new CheckinDatabase(dbFile);
    const log = (level, event, message, details) => {
      setupDb.log(null, level, event, message, details);
      console.log(`[${level}] ${event}: ${message}`);
    };
    log("info", "github_binding_start", "已打开 GitHub 账号绑定窗口");
    fs.rmSync(pendingProfileDir, { recursive: true, force: true });
    const session = await interactiveSetup({ profileDir: pendingProfileDir, baseUrl });
    context = session.context;
    const { page } = session;
    console.log("请在全新的 Chrome 配置中登录需要绑定的 GitHub 账号并完成 2FA。");
    let githubUsername = await waitForGithubLogin(context, page, log);
    const authenticatedCookies = persistentGithubCookies(await context.cookies("https://github.com"));
    await context.addCookies(authenticatedCookies);
    log("info", "github_login_detected", `已检测到 GitHub 登录${githubUsername ? `：@${githubUsername}` : ""}`);
    console.log(`已检测到 GitHub 登录${githubUsername ? `：@${githubUsername}` : ""}，正在关闭登录窗口。`);
    await context.close();
    context = null;

    console.log("GitHub 登录已完成，正在等待当前后台任务结束。");
    operationLock = await waitForRunLock();
    console.log("正在验证 AgentRouter OAuth，请稍候。");
    const result = await runCheckin({
      profileDir: pendingProfileDir,
      baseUrl,
      headless: true,
      log,
      githubCookies: authenticatedCookies,
    });
    sendSecretMessage({ type: "github-session", cookies: persistentGithubCookies(result.githubCookies || authenticatedCookies) });
    const account = {
      githubUsername: githubUsername || result.username || null,
      agentRouterUsername: result.username || null,
      agentRouterUserId: result.userId || null,
      boundAt: new Date().toISOString(),
    };
    const previousAccount = fs.existsSync(accountFile) ? fs.readFileSync(accountFile) : null;
    replaceBrowserProfile({
      currentProfileDir: profileDir,
      pendingProfileDir,
      previousProfileDir,
      finalize: () => {
        try {
          fs.writeFileSync(accountFile, JSON.stringify(account, null, 2));
          if (result.balance) {
            const db = new CheckinDatabase(dbFile);
            try { db.saveAccountSnapshot(result.balance); }
            finally { db.close(); }
          }
        } catch (error) {
          if (previousAccount) fs.writeFileSync(accountFile, previousAccount);
          else fs.rmSync(accountFile, { force: true });
          throw error;
        }
      },
    });
    committed = true;
    log("info", "github_binding_complete", `GitHub 账号绑定完成${account.githubUsername ? `：@${account.githubUsername}` : ""}`);
    console.log(`账号切换完成${account.githubUsername ? `：@${account.githubUsername}` : ""}。`);
  } catch (error) {
    if (setupDb) setupDb.log(
      null,
      "error",
      "github_binding_failure",
      error instanceof AuthRequiredError ? "GitHub 登录状态不可用，请在设置页点击“切换账号”重新绑定" : error.message,
      error instanceof AuthRequiredError ? null : { stack: error.stack },
    );
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (!committed) fs.rmSync(pendingProfileDir, { recursive: true, force: true });
    try {
      if (operationLock) releaseLock(operationLock);
    } finally {
      if (setupDb) setupDb.close();
      releaseLock(setupLock, setupLockFile);
    }
  }
}

async function doctor() {
  fs.mkdirSync(dataDir, { recursive: true });
  const executable = chromium.executablePath();
  const db = new CheckinDatabase(dbFile);
  const recent = db.recentRuns(5);
  db.close();
  console.log(JSON.stringify({ node: process.version, baseUrl, dataDir, dbFile, bundledChromium: executable, recentRuns: recent }, null, 2));
}

const command = process.argv[2] || "run";
if (command === "run") await run();
else if (command === "setup") await setup();
else if (command === "setup-auto") await automaticSetup();
else if (command === "doctor") await doctor();
else if (command === "balance") await balance();
else if (command === "backup-export") await migration("export", process.argv[3]);
else if (command === "backup-import") await migration("import", process.argv[3]);
else {
  console.error("用法：node src/cli.js <setup|setup-auto|run|balance|backup-export|backup-import|doctor>");
  process.exitCode = 64;
}
