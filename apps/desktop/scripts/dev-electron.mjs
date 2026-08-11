import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronRoot = path.join(desktopRoot, "electron");
let child = null;
let restartTimer = null;
let stopping = false;
let restarting = false;

function launch() {
  if (stopping) return;
  child = spawn(electronPath, [path.join(electronRoot, "main.mjs")], {
    cwd: desktopRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("exit", (code) => {
    child = null;
    if (stopping) return;
    if (restarting) {
      restarting = false;
      launch();
      return;
    }
    process.exit(code ?? 0);
  });
}

function restart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!child) {
      launch();
      return;
    }
    restarting = true;
    child.kill();
  }, 180);
}

const watcher = fs.watch(electronRoot, { recursive: true }, (_event, filename) => {
  if (filename && /\.(?:mjs|cjs|js)$/i.test(filename)) {
    console.log(`Electron 后台文件已更新：${filename}，正在重启…`);
    restart();
  }
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watcher.close();
  if (child) child.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

launch();
