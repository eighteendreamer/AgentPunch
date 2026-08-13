import assert from "node:assert/strict";
import test from "node:test";
import { taskInternals } from "../src/windows-task.js";

test("next task run is calculated locally", () => {
  const before = new Date(2026, 7, 11, 8, 0, 0);
  const after = new Date(2026, 7, 11, 10, 0, 0);
  assert.equal(taskInternals.nextDailyRun("09:00", before).getDate(), 11);
  assert.equal(taskInternals.nextDailyRun("09:00", after).getDate(), 12);
});

test("scheduled task XML contains both logon and daily triggers", () => {
  const xml = taskInternals.taskXml({ projectRoot: "G:\\AgentPunch", dailyTime: "09:30" });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<CalendarTrigger>/);
  assert.match(xml, /T09:30:00/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test("packaged scheduled task starts the installed application", () => {
  const xml = taskInternals.taskXml({
    projectRoot: "C:\\Program Files\\AgentPunch\\resources\\agentpunch-runtime",
    dailyTime: "09:30",
    appExecutable: "C:\\Program Files\\AgentPunch\\AgentPunch.exe",
  });
  assert.match(xml, /AgentPunch\.exe/);
  assert.match(xml, /<Arguments>--background-checkin<\/Arguments>/);
  assert.doesNotMatch(xml, /src\\cli\.js.*run/);
});

test("legacy source tasks are identified for migration", () => {
  const xml = `
    <Task><Actions><Exec>
      <Command>C:\\Program Files\\nodejs\\node.exe</Command>
      <Arguments>--disable-warning=ExperimentalWarning &quot;G:\\OldSource\\src\\cli.js&quot; run</Arguments>
    </Exec></Actions></Task>`;
  assert.deepEqual(taskInternals.inspectTaskXml(xml, "C:\\Program Files\\AgentPunch\\AgentPunch.exe"), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    arguments: '--disable-warning=ExperimentalWarning "G:\\OldSource\\src\\cli.js" run',
    taskSource: "legacy-source",
    needsMigration: true,
    configuredDailyTime: null,
  });
});

test("installed hidden task does not need migration", () => {
  const executable = "C:\\Users\\User\\AppData\\Local\\Programs\\AgentPunch\\AgentPunch.exe";
  const xml = `<Task><Actions><Exec><Command>${executable}</Command><Arguments>--background-checkin</Arguments></Exec></Actions></Task>`;
  const result = taskInternals.inspectTaskXml(xml, executable);
  assert.equal(result.taskSource, "installed");
  assert.equal(result.needsMigration, false);
});

test("legacy task migration preserves its configured daily time", () => {
  const xml = `<Task><Triggers><CalendarTrigger><StartBoundary>2026-08-12T10:30:00+08:00</StartBoundary></CalendarTrigger></Triggers><Actions><Exec><Command>node.exe</Command><Arguments>G:\\OldSource\\src\\cli.js run</Arguments></Exec></Actions></Task>`;
  assert.equal(taskInternals.inspectTaskXml(xml, "C:\\AgentPunch\\AgentPunch.exe").configuredDailyTime, "10:30");
});

test("task status calculations can use the trigger time read from task XML", () => {
  const xml = `<Task><Triggers><CalendarTrigger><StartBoundary>2026-08-12T13:45:00</StartBoundary></CalendarTrigger></Triggers></Task>`;
  const configured = taskInternals.inspectTaskXml(xml).configuredDailyTime;
  assert.equal(configured, "13:45");
  const now = new Date(2026, 7, 13, 10, 0, 0);
  const next = taskInternals.nextDailyRun(configured, now);
  assert.equal(next.getHours(), 13);
  assert.equal(next.getMinutes(), 45);
});
