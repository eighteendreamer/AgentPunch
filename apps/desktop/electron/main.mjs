import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const projectRoot = app.isPackaged
  ? path.join(process.resourcesPath, "agentpunch-runtime")
  : path.resolve(desktopRoot, "..", "..");
const { CheckinDatabase } = await import(pathToFileURL(path.join(projectRoot, "src", "db.js")).href);
const { getWindowsTaskStatus, installWindowsTask, uninstallWindowsTask } = await import(
  pathToFileURL(path.join(projectRoot, "src", "windows-task.js")).href,
);
const dataDir = process.env.AGENT_ROUTER_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "AgentRouterCheckin");
const dbFile = path.join(dataDir, "checkin.sqlite3");
const settingsFile = path.join(dataDir, "settings.json");
const accountFile = path.join(dataDir, "account.json");
const githubSessionFile = path.join(dataDir, "github-session.bin");
const authStateFile = path.join(dataDir, "auth-state.json");
const taskName = "AgentRouterDailyCheckin";
let balanceRefreshPromise = null;
const screenshotOutput =
  process.argv.find((argument) => argument.startsWith("--screenshot="))?.slice("--screenshot=".length) ||
  process.env.AGENTPUNCH_SCREENSHOT;
const initialPage = process.argv.find((argument) => argument.startsWith("--page="))?.slice("--page=".length) || "home";

function readSettings() {
  const defaults = {
    dailyTime: "09:00",
    headless: true,
    launchAtLogon: true,
    taskEnabled: false,
    taskNextRunTime: null,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, "utf8")) };
  } catch {
    return defaults;
  }
}

function writeSettings(settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  const next = { ...readSettings(), ...settings };
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
  return next;
}

function readAccount() {
  try { return JSON.parse(fs.readFileSync(accountFile, "utf8")); }
  catch { return null; }
}

function readGithubSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(githubSessionFile)));
  } catch {
    return null;
  }
}

function writeGithubSession(payload) {
  if (!payload?.cookies?.length) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用");
  fs.mkdirSync(dataDir, { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(payload));
  const temporary = `${githubSessionFile}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.rmSync(githubSessionFile, { force: true });
  fs.renameSync(temporary, githubSessionFile);
  fs.writeFileSync(authStateFile, JSON.stringify({ valid: true, verifiedAt: new Date().toISOString() }), "utf8");
}

function readAuthState() {
  try { return JSON.parse(fs.readFileSync(authStateFile, "utf8")); }
  catch { return { valid: Boolean(readGithubSession()?.cookies?.length), verifiedAt: null }; }
}

function markAuthInvalid() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(authStateFile, JSON.stringify({ valid: false, invalidatedAt: new Date().toISOString() }), "utf8");
}

async function taskStatus() {
  const settings = readSettings();
  let result = await getWindowsTaskStatus({
    taskName,
    dailyTime: settings.dailyTime,
    expectedAppExecutable: app.isPackaged ? process.execPath : null,
  });
  if (app.isPackaged && result.installed && result.needsMigration) {
    const migratedDailyTime = result.configuredDailyTime || settings.dailyTime;
    await installWindowsTask({
      taskName,
      projectRoot,
      dailyTime: migratedDailyTime,
      dataDir,
      appExecutable: process.execPath,
    });
    result = await getWindowsTaskStatus({
      taskName,
      dailyTime: migratedDailyTime,
      expectedAppExecutable: process.execPath,
    });
    result.migratedFromLegacy = true;
    result.migratedDailyTime = migratedDailyTime;
  }
  writeSettings({
    taskEnabled: result.installed,
    taskNextRunTime: result.nextRunTime || null,
    ...(result.configuredDailyTime ? { dailyTime: result.configuredDailyTime } : {}),
  });
  return result;
}

function runNodeCli(args, env = {}, input = null, onOutput = null) {
  return new Promise((resolve) => {
    const executable = app.isPackaged ? process.execPath : "node";
    const child = spawn(executable, ["--disable-warning=ExperimentalWarning", path.join(projectRoot, "src", "cli.js"), ...args], {
      cwd: projectRoot,
      env: { ...process.env, ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}), ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onOutput?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onOutput?.(String(chunk));
    });
    let secretsBuffer = "";
    child.stdio[4].setEncoding("utf8");
    child.stdio[4].on("data", (chunk) => {
      secretsBuffer += chunk;
      let newline;
      while ((newline = secretsBuffer.indexOf("\n")) >= 0) {
        const line = secretsBuffer.slice(0, newline);
        secretsBuffer = secretsBuffer.slice(newline + 1);
        try {
          const payload = JSON.parse(line);
          if (payload?.type === "github-session") writeGithubSession(payload);
        } catch {}
      }
    });
    const savedSession = readGithubSession();
    child.stdio[3].end(`${JSON.stringify({ type: "github-session", cookies: savedSession?.cookies || [] })}\n`);
    child.on("close", (code) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (code === 2 || output.includes("GitHub 登录态已失效") || output.includes("GitHub 登录状态不可用")) markAuthInvalid();
      resolve({ ok: code === 0, code, output });
    });
    child.on("error", (error) => resolve({ ok: false, code: -1, output: error.message }));
    if (input == null) child.stdin.end();
    else child.stdin.end(input);
  });
}

function migrationError(output) {
  if (output?.includes("已有签到进程")) return "签到或余额任务正在运行，请稍后再试";
  if (output?.includes("迁移密码错误")) return "迁移密码错误，或迁移包已经损坏";
  if (output?.includes("至少需要 8 个字符")) return "迁移密码至少需要 8 个字符";
  if (output?.includes("没有找到有效的 GitHub")) return "没有找到有效的 GitHub 登录状态，请先重新绑定";
  if (output?.includes("GitHub 登录状态已过期")) return "迁移包中的 GitHub 登录状态已过期；数据已保留，请重新绑定 GitHub 账号";
  if (output?.includes("无法在线验证迁移包")) return "无法在线验证迁移包中的 GitHub 登录状态，请检查网络后重试";
  return "迁移操作失败，请检查迁移包后重试";
}

function setupError(output) {
  if (output?.includes("已有账号切换流程")) return "已有账号切换流程正在运行";
  if (output?.includes("等待签到或余额任务结束超时")) return "当前签到或余额任务长时间未结束，请稍后重试";
  if (output?.includes("Timeout") || output?.includes("timeout")) return "等待 GitHub 登录超时，请重新绑定";
  if (output?.includes("Target page") || output?.includes("closed")) return "绑定窗口已关闭，GitHub 登录尚未完成";
  if (output?.includes("登录未完成") || output?.includes("登录态已失效") || output?.includes("GitHub 仍未登录")) return "GitHub 登录尚未完成，请点击“切换账号”重新绑定";
  return "GitHub 绑定失败，请检查 Chrome 是否可以正常打开";
}

function setupProgressMessage(output) {
  if (output.includes("全新的 Chrome")) return "Chrome 已打开，请登录新的 GitHub 账号并完成 2FA";
  if (output.includes("已检测到 GitHub 登录")) return "已检测到 GitHub 登录，正在关闭登录窗口";
  if (output.includes("等待当前后台任务")) return "GitHub 已登录，正在等待后台任务结束";
  if (output.includes("验证 AgentRouter OAuth") || output.includes("oauth_start")) return "GitHub 已登录，正在验证 AgentRouter OAuth";
  if (output.includes("账号切换完成")) return "新账号验证完成";
  return null;
}

async function getStatus() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new CheckinDatabase(dbFile);
  const runs = db.recentRuns(30);
  const balanceSnapshots = db.latestAccountSnapshot();
  db.close();
  const settings = readSettings();
  const authState = readAuthState();
  // 兼容：如果返回的是单条快照对象（旧数据），转换为 { agentrouter: snapshot } 格式
  let balance = null;
  if (balanceSnapshots) {
    if (balanceSnapshots.balance !== undefined) {
      // 旧格式：单条快照
      balance = { agentrouter: balanceSnapshots };
    } else {
      // 新格式：{ siteId: snapshot }
      balance = balanceSnapshots;
    }
  }
  return {
    runs,
    latestRun: runs[0] || null,
    successfulToday: runs.some((run) => run.local_date === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()) && run.status === "success"),
    initialized: Boolean(readGithubSession()?.cookies?.length) && authState.valid !== false,
    authState,
    task: {
      installed: settings.taskEnabled,
      state: settings.taskEnabled ? "Cached" : "NotInstalled",
      nextRunTime: settings.taskNextRunTime,
    },
    balance,
    account: readAccount(),
    settings,
    dataDir,
    appVersion: desktopPackage.version,
  };
}

async function setTaskEnabled(enabled) {
  const settings = readSettings();
  if (enabled) {
    await installWindowsTask({
      taskName,
      projectRoot,
      dailyTime: settings.dailyTime,
      dataDir,
      appExecutable: app.isPackaged ? process.execPath : null,
    });
  } else {
    await uninstallWindowsTask({ taskName });
  }
  writeSettings({ taskEnabled: Boolean(enabled), taskNextRunTime: enabled ? readSettings().taskNextRunTime : null });
  return taskStatus();
}

async function refreshBalance() {
  if (balanceRefreshPromise) return balanceRefreshPromise;
  balanceRefreshPromise = (async () => {
    const settings = readSettings();
    const result = await runNodeCli(["balance"], {
      AGENT_ROUTER_HEADLESS: settings.headless ? "true" : "false",
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.code === 2 ? "登录状态已失效，请重新绑定 GitHub" : result.output.includes("已有签到进程") ? "签到任务正在运行，稍后会自动更新余额" : "余额暂时无法更新",
      };
    }
    const db = new CheckinDatabase(dbFile);
    const data = db.latestAccountSnapshot();
    db.close();
    // 兼容：如果返回的是单条快照对象（旧格式），包装为 { agentrouter: snapshot }
    let balanceData = null;
    if (data) {
      if (data.balance !== undefined) {
        balanceData = { agentrouter: data };
      } else {
        balanceData = data;
      }
    }
    return balanceData ? { ok: true, data: balanceData } : { ok: false, error: "余额暂时无法更新" };
  })().finally(() => {
    balanceRefreshPromise = null;
  });
  return balanceRefreshPromise;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f5f6f8",
    title: "AgentPunch",
    icon: path.join(desktopRoot, app.isPackaged ? "dist" : "public", "agentpunch-logo.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?page=${encodeURIComponent(initialPage)}`);
  else win.loadFile(path.join(desktopRoot, "dist", "index.html"), { query: { page: initialPage } });
  if (screenshotOutput) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(screenshotOutput, image.toPNG());
        app.quit();
      }, 6_500);
    });
  }
}

ipcMain.handle("agent:get-status", getStatus);
ipcMain.handle("agent:get-task-status", taskStatus);
ipcMain.handle("agent:get-logs", () => {
  const db = new CheckinDatabase(dbFile);
  try {
    return db.recentLogs(1000).map((entry) => {
      if (!/(?:github_auth_required|github_binding_failure)/i.test(entry.event) && !/npm run setup|GitHub 登录态已失效|GitHub 登录状态已失效/i.test(entry.message)) return entry;
      return {
        ...entry,
        message: "GitHub 登录状态不可用，请在设置页点击“切换账号”重新绑定",
        details_json: null,
      };
    });
  } finally {
    db.close();
  }
});
ipcMain.handle("agent:refresh-balance", refreshBalance);
ipcMain.handle("agent:run-checkin", async (_event, { force }) => {
  const settings = readSettings();
  return runNodeCli(["run"], {
    AGENT_ROUTER_FORCE: force ? "true" : "false",
    AGENT_ROUTER_HEADLESS: settings.headless ? "true" : "false",
  });
});
ipcMain.handle("agent:set-task-enabled", (_event, { enabled }) => setTaskEnabled(enabled));
ipcMain.handle("agent:save-settings", async (_event, settings) => {
  const previous = readSettings();
  const currentTask = await getWindowsTaskStatus({
    taskName,
    dailyTime: previous.dailyTime,
    expectedAppExecutable: app.isPackaged ? process.execPath : null,
  });
  const next = { ...previous, ...settings };
  if (currentTask.installed) {
    await installWindowsTask({
      taskName,
      projectRoot,
      dailyTime: next.dailyTime,
      dataDir,
      appExecutable: app.isPackaged ? process.execPath : null,
    });
  }
  writeSettings(settings);
  const task = await taskStatus();
  return { settings: readSettings(), task };
});
ipcMain.handle("agent:start-setup", async (event) => {
  const result = await runNodeCli(["setup-auto"], {
    AGENT_ROUTER_HEADLESS: "false",
  }, null, (output) => {
    const message = setupProgressMessage(output);
    if (message && !event.sender.isDestroyed()) event.sender.send("agent:setup-progress", { message });
  });
  return result.ok ? { ok: true } : { ok: false, error: setupError(result.output) };
});
ipcMain.handle("agent:open-data-folder", async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  await shell.openPath(dataDir);
  return { ok: true };
});
ipcMain.handle("agent:export-data", async (_event, { password }) => {
  const selected = await dialog.showSaveDialog({
    title: "导出 AgentPunch 迁移包",
    defaultPath: `AgentPunch-${new Date().toISOString().slice(0, 10)}.agentpunch-backup`,
    filters: [{ name: "AgentPunch 迁移包", extensions: ["agentpunch-backup"] }],
  });
  if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
  const result = await runNodeCli(["backup-export", selected.filePath], {}, `${password}\n`);
  return result.ok ? { ok: true, filePath: selected.filePath } : { ok: false, error: migrationError(result.output) };
});
ipcMain.handle("agent:import-data", async (_event, { password }) => {
  const selected = await dialog.showOpenDialog({
    title: "导入 AgentPunch 迁移包",
    properties: ["openFile"],
    filters: [{ name: "AgentPunch 迁移包", extensions: ["agentpunch-backup"] }],
  });
  if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
  const result = await runNodeCli(["backup-import", selected.filePaths[0]], {}, `${password}\n`);
  return result.ok ? { ok: true } : { ok: false, error: migrationError(result.output) };
});

app.whenReady().then(() => {
  if (process.argv.includes("--background-checkin")) {
    runNodeCli(["run"], process.argv.includes("--force") ? { AGENT_ROUTER_FORCE: "true" } : {}).then((result) => {
      if (!result.ok) process.exitCode = result.code || 1;
    }).finally(() => app.quit());
    return;
  }
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
