import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "patchright";
import { AuthRequiredError, interactiveSetup, runCheckin } from "./checkin.js";
import { CheckinDatabase } from "./db.js";

const baseUrl = (process.env.AGENT_ROUTER_BASE_URL || "https://ps.air-outer.com").replace(/\/$/, "");
const dataDir = process.env.AGENT_ROUTER_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "AgentRouterCheckin");
const profileDir = path.join(dataDir, "browser-profile");
const dbFile = path.join(dataDir, "checkin.sqlite3");
const lockFile = path.join(dataDir, "run.lock");

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

function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    return fs.openSync(lockFile, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (age < 20 * 60_000) throw new Error("已有签到进程正在运行");
    fs.rmSync(lockFile, { force: true });
    return fs.openSync(lockFile, "wx");
  }
}

function releaseLock(fd) {
  try {
    fs.closeSync(fd);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
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
    const result = await runCheckin({
      profileDir,
      baseUrl,
      headless: process.env.AGENT_ROUTER_HEADLESS !== "false",
      log,
    });
    const message = result.checkedIn ? "签到成功，新增额度已到账" : "登录成功，但站点未返回 checked_in=true";
    db.finishRun(runId, { status: "success", checkedIn: result.checkedIn, message, details: result });
    log("info", "complete", message, result);
    console.log(message);
  } catch (error) {
    const status = error instanceof AuthRequiredError ? "auth_required" : "failure";
    if (runId) {
      db.finishRun(runId, { status, message: error.message });
      db.log(runId, "error", status, error.message, { stack: error.stack });
    }
    console.error(error.message);
    process.exitCode = status === "auth_required" ? 2 : 1;
  } finally {
    db.close();
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
    await page.goto("https://github.com/settings/profile", { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (page.url().startsWith("https://github.com/login")) {
      throw new AuthRequiredError("GitHub 仍未登录，请重新运行 npm run setup");
    }
    console.log("GitHub 登录态已保存在独立 Chrome 配置中。现在执行一次站点签到验证……");
  } finally {
    await context.close();
    rl.close();
  }
  await run();
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
else if (command === "doctor") await doctor();
else {
  console.error("用法：node src/cli.js <setup|run|doctor>");
  process.exitCode = 64;
}
