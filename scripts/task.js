import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getWindowsTaskStatus, installWindowsTask, uninstallWindowsTask } from "../src/windows-task.js";

const taskName = "AgentRouterDailyCheckin";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.AGENT_ROUTER_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "AgentRouterCheckin");
const command = process.argv[2];
const dailyTime = process.argv[3] || "09:00";

if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) {
  throw new Error("每日执行时间必须是 HH:mm 格式");
}

if (command === "install") {
  await installWindowsTask({ taskName, projectRoot, dailyTime, dataDir });
  console.log(`自动签到任务已安装，每天 ${dailyTime} 运行。`);
} else if (command === "uninstall") {
  await uninstallWindowsTask({ taskName });
  console.log("自动签到任务已卸载。");
} else if (command === "status") {
  console.log(JSON.stringify(await getWindowsTaskStatus({ taskName, dailyTime }), null, 2));
} else {
  console.error("用法：node scripts/task.js <install|uninstall|status> [HH:mm]");
  process.exitCode = 64;
}
