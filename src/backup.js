import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "patchright";
import { DatabaseSync } from "node:sqlite";
import { githubSessionFromCookies } from "./profile-binding.js";

const FORMAT = "agentpunch-migration";
const VERSION = 1;

function requirePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("迁移密码至少需要 8 个字符");
  }
}

function encryptPayload(payload, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptPayload(container, password) {
  if (container?.format !== FORMAT || container?.version !== VERSION) {
    throw new Error("不是有效的 AgentPunch 迁移包，或版本暂不支持");
  }
  try {
    const salt = Buffer.from(container.salt, "base64");
    const iv = Buffer.from(container.iv, "base64");
    const tag = Buffer.from(container.tag, "base64");
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(container.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("迁移密码错误，或迁移包已经损坏");
  }
}

function readJson(filename, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return fallback;
  }
}

function snapshotDatabase(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return fs.readFileSync(dbFile).toString("base64");
}

function portableCookies(cookies) {
  return cookies
    .filter((cookie) => /(^|\.)github\.com$/i.test(cookie.domain))
    .map(({ name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite, partitionKey }) => ({
      name,
      value,
      domain,
      path: cookiePath,
      expires,
      httpOnly,
      secure,
      sameSite,
      ...(partitionKey ? { partitionKey } : {}),
    }));
}

export async function exportMigrationPackage({ dataDir, profileDir, outputFile, password, headless = true, githubCookies = [] }) {
  requirePassword(password);
  if (!fs.existsSync(profileDir)) throw new Error("尚未绑定 GitHub，无法导出登录状态");

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
  });
  let cookies;
  try {
    if (githubCookies.length) await context.addCookies(portableCookies(githubCookies));
    cookies = portableCookies(await context.cookies("https://github.com"));
  } finally {
    await context.close();
  }
  if (!cookies.some((cookie) => cookie.name === "user_session" || cookie.name === "__Host-user_session_same_site")) {
    throw new Error("没有找到有效的 GitHub 登录状态，请先重新绑定账号");
  }

  const settingsFile = path.join(dataDir, "settings.json");
  const accountFile = path.join(dataDir, "account.json");
  const dbFile = path.join(dataDir, "checkin.sqlite3");
  const payload = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    settings: readJson(settingsFile),
    account: readJson(accountFile, null),
    database: snapshotDatabase(dbFile),
    github: { cookies },
  };
  const container = encryptPayload(payload, password);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(container), { encoding: "utf8", mode: 0o600 });
  fs.rmSync(outputFile, { force: true });
  fs.renameSync(temporary, outputFile);
  return { cookieCount: cookies.length, hasDatabase: Boolean(payload.database), createdAt: payload.createdAt };
}

export async function importMigrationPackage({ dataDir, profileDir, inputFile, password, headless = true }) {
  requirePassword(password);
  const container = readJson(inputFile, null);
  const payload = decryptPayload(container, password);
  if (!Array.isArray(payload?.github?.cookies) || payload.github.cookies.length === 0) {
    throw new Error("迁移包中没有 GitHub 登录状态");
  }

  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
  });
  let verifiedGithubCookies = [];
  try {
    await context.clearCookies({ domain: /(^|\.)github\.com$/i });
    await context.addCookies(portableCookies(payload.github.cookies));
    const page = context.pages()[0] ?? (await context.newPage());
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await page.goto("https://github.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
    if (lastError) throw new Error("无法在线验证迁移包中的 GitHub 登录状态，请检查网络后重试");
    const session = githubSessionFromCookies(await context.cookies("https://github.com"));
    if (!session || page.url().startsWith("https://github.com/login")) {
      throw new Error("迁移包中的 GitHub 登录状态已过期，请导入后重新绑定 GitHub 账号");
    }
    verifiedGithubCookies = portableCookies(await context.cookies("https://github.com"));
  } finally {
    await context.close();
  }

  const settingsFile = path.join(dataDir, "settings.json");
  const accountFile = path.join(dataDir, "account.json");
  const dbFile = path.join(dataDir, "checkin.sqlite3");
  if (payload.database) {
    const currentDatabase = snapshotDatabase(dbFile);
    if (currentDatabase) fs.writeFileSync(`${dbFile}.before-import.bak`, Buffer.from(currentDatabase, "base64"));
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });
    fs.writeFileSync(dbFile, Buffer.from(payload.database, "base64"));
  }
  fs.writeFileSync(settingsFile, JSON.stringify({
    ...readJson(settingsFile),
    ...payload.settings,
    taskEnabled: false,
    taskNextRunTime: null,
  }, null, 2));
  if (payload.account) fs.writeFileSync(accountFile, JSON.stringify(payload.account, null, 2));

  return {
    cookieCount: payload.github.cookies.length,
    hasDatabase: Boolean(payload.database),
    createdAt: payload.createdAt || null,
    githubUsername: payload.github.cookies.find((cookie) => cookie.name === "dotcom_user")?.value || payload.account?.githubUsername || null,
    githubCookies: verifiedGithubCookies,
  };
}

export const backupInternals = { encryptPayload, decryptPayload, portableCookies };
