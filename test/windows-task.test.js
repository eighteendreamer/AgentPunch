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
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<CalendarTrigger>/);
  assert.match(xml, /T09:30:00/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});
