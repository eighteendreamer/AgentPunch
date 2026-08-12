import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function findNodeExecutable() {
  if (path.basename(process.execPath).toLowerCase() === "node.exe") return process.execPath;
  for (const directory of (process.env.Path || process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory.replace(/^"|"$/g, ""), "node.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node.exe";
}

function nextDailyRun(dailyTime, now = new Date()) {
  const [hours, minutes] = dailyTime.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function decodeXml(value = "") {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : null;
}

function inspectTaskXml(xml, expectedAppExecutable = null) {
  const command = tagValue(xml, "Command");
  const argumentsText = tagValue(xml, "Arguments") || "";
  const normalizedCommand = command ? path.resolve(command).toLowerCase() : "";
  const normalizedExpected = expectedAppExecutable ? path.resolve(expectedAppExecutable).toLowerCase() : "";
  const isInstalledAppTask = Boolean(
    normalizedExpected && normalizedCommand === normalizedExpected && argumentsText.includes("--background-checkin"),
  );
  const isLegacySourceTask = Boolean(
    /(?:^|\\|\/)node\.exe$/i.test(command || "") ||
    /src[\\/]cli\.js/i.test(argumentsText) ||
    /powershell/i.test(command || ""),
  );
  const startBoundary = tagValue(xml, "StartBoundary");
  const configuredDailyTime = startBoundary?.match(/T(\d{2}:\d{2})/)?.[1] || null;
  return {
    command,
    arguments: argumentsText,
    taskSource: isInstalledAppTask ? "installed" : isLegacySourceTask ? "legacy-source" : "other",
    needsMigration: Boolean(expectedAppExecutable && !isInstalledAppTask),
    configuredDailyTime,
  };
}

function taskXml({ projectRoot, dailyTime, appExecutable = null }) {
  const node = appExecutable || findNodeExecutable();
  const script = path.join(projectRoot, "src", "cli.js");
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
  const boundary = new Date();
  const [hours, minutes] = dailyTime.split(":").map(Number);
  boundary.setHours(hours, minutes, 0, 0);
  const localBoundary = `${boundary.getFullYear()}-${String(boundary.getMonth() + 1).padStart(2, "0")}-${String(boundary.getDate()).padStart(2, "0")}T${dailyTime}:00`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent Router GitHub OAuth daily check-in. Runs at logon and the configured daily time.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(user)}</UserId></LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>${localBoundary}</StartBoundary><Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${escapeXml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT10M</Interval><Count>3</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(node)}</Command>
      <Arguments>${appExecutable ? "--background-checkin" : `--disable-warning=ExperimentalWarning &quot;${escapeXml(script)}&quot; run`}</Arguments>
      <WorkingDirectory>${escapeXml(projectRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

export async function getWindowsTaskStatus({ taskName, dailyTime, expectedAppExecutable = null }) {
  try {
    const { stdout } = await execFileAsync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const enabled = !/<Enabled>\s*false\s*<\/Enabled>/i.test(stdout);
    const inspection = inspectTaskXml(stdout, expectedAppExecutable);
    return {
      installed: true,
      state: enabled ? "Ready" : "Disabled",
      nextRunTime: enabled ? nextDailyRun(dailyTime).toISOString() : null,
      lastRunTime: null,
      lastTaskResult: null,
      ...inspection,
    };
  } catch {
    return { installed: false, state: "NotInstalled", nextRunTime: null, lastRunTime: null, lastTaskResult: null };
  }
}

export async function installWindowsTask({ taskName, projectRoot, dailyTime, dataDir, appExecutable = null }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const xmlFile = path.join(dataDir, `${taskName}.xml`);
  // Task Scheduler on some localized Windows installations rejects UTF-8 task
  // files with "XML format is incorrect / cannot switch encoding". Its native
  // XML export format is UTF-16LE with a BOM, so write the import file likewise.
  fs.writeFileSync(xmlFile, `\uFEFF${taskXml({ projectRoot, dailyTime, appExecutable })}`, "utf16le");
  try {
    await execFileAsync("schtasks.exe", ["/Create", "/TN", taskName, "/XML", xmlFile, "/F"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    fs.rmSync(xmlFile, { force: true });
  }
}

export async function uninstallWindowsTask({ taskName }) {
  try {
    await execFileAsync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], { windowsHide: true });
  } catch (error) {
    const status = await getWindowsTaskStatus({ taskName, dailyTime: "09:00" });
    if (status.installed) throw error;
  }
}

export const taskInternals = { inspectTaskXml, nextDailyRun, taskXml };
