import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckinDatabase, sanitizeDetails } from "../src/db.js";

test("GitHub session cookies are removed before details are persisted", () => {
  assert.deepEqual(sanitizeDetails({
    checkedIn: true,
    githubCookies: [{ name: "user_session", value: "secret" }],
    nested: { githubCookies: [{ name: "_gh_sess", value: "secret" }], ok: true },
  }), { checkedIn: true, nested: { ok: true } });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-redaction-"));
  const filename = path.join(dir, "test.sqlite3");
  const db = new CheckinDatabase(filename);
  try {
    const runId = db.beginRun("2026-08-13");
    db.finishRun(runId, {
      status: "success",
      details: { checkedIn: true, githubCookies: [{ name: "user_session", value: "secret" }] },
    });
    const stored = db.db.prepare("SELECT details_json FROM runs WHERE id = ?").get(runId).details_json;
    assert.equal(stored, JSON.stringify({ checkedIn: true }));
    assert.doesNotMatch(stored, /user_session|githubCookies|secret/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("successful daily run is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-checkin-"));
  const db = new CheckinDatabase(path.join(dir, "test.sqlite3"));
  try {
    assert.equal(db.hasSuccessfulRun("2026-08-11"), false);
    const failed = db.beginRun("2026-08-11");
    db.finishRun(failed, { status: "failure", message: "temporary" });
    assert.equal(db.hasSuccessfulRun("2026-08-11"), false);
    const success = db.beginRun("2026-08-11");
    db.finishRun(success, { status: "success", checkedIn: true });
    assert.equal(db.hasSuccessfulRun("2026-08-11"), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("latest account snapshot is available without a network request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-balance-"));
  const db = new CheckinDatabase(path.join(dir, "test.sqlite3"));
  try {
    db.saveAccountSnapshot({
      balance: 49.8,
      used: 1450.2,
      requestCount: 2312,
      quotaPerUnit: 500000,
      currency: "$",
      updatedAt: "2026-08-11T01:00:00.000Z",
    });
    assert.deepEqual(db.latestAccountSnapshot(), {
      capturedAt: "2026-08-11T01:00:00.000Z",
      updatedAt: "2026-08-11T01:00:00.000Z",
      balance: 49.8,
      used: 1450.2,
      requestCount: 2312,
      quotaPerUnit: 500000,
      currency: "$",
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logs are returned newest first with run context", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-db-"));
  const db = new CheckinDatabase(path.join(dir, "test.sqlite3"));
  const runId = db.beginRun("2026-08-13");
  db.log(runId, "info", "oauth_start", "开始授权");
  db.log(runId, "error", "failure", "连接失败", { code: "ERR_CONNECTION_RESET" });
  const logs = db.recentLogs(10);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].level, "error");
  assert.equal(logs[0].local_date, "2026-08-13");
  assert.equal(logs[0].run_id, runId);
  assert.match(logs[0].details_json, /ERR_CONNECTION_RESET/);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("logs can be tagged with a site identifier for multi-site checkin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-site-"));
  const db = new CheckinDatabase(path.join(dir, "test.sqlite3"));
  const runId = db.beginRun("2026-08-13");
  db.log(runId, "info", "site_agentrouter_start", "开始 AgentRouter 签到", null, "agentrouter");
  db.log(runId, "info", "site_justwoker_start", "开始 JustDoWork 签到", null, "justwoker");
  db.log(runId, "error", "site_justwoker_failed", "JustDoWork 签到失败", { error: "timeout" }, "justwoker");
  const logs = db.recentLogs(10);
  assert.equal(logs.length, 3);
  const justwokerLogs = logs.filter((l) => l.site === "justwoker");
  assert.equal(justwokerLogs.length, 2);
  const agentrouterLogs = logs.filter((l) => l.site === "agentrouter");
  assert.equal(agentrouterLogs.length, 1);
  assert.equal(logs[0].site, "justwoker");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
