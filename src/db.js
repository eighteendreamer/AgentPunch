import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function sanitizeDetails(value) {
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "githubCookies")
      .map(([key, entry]) => [key, sanitizeDetails(entry)]),
  );
}

function json(value) {
  return value == null ? null : JSON.stringify(sanitizeDetails(value));
}

export class CheckinDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_date TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        checked_in INTEGER,
        message TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_date_status
        ON runs(local_date, status);
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        balance REAL NOT NULL,
        used REAL NOT NULL,
        request_count INTEGER NOT NULL,
        quota_per_unit REAL NOT NULL,
        currency TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_captured_at
        ON account_snapshots(captured_at DESC);
    `);
    this.scrubSensitiveDetails();
  }

  scrubSensitiveDetails() {
    for (const table of ["runs", "logs"]) {
      const rows = this.db.prepare(`SELECT id, details_json FROM ${table} WHERE details_json LIKE '%githubCookies%'`).all();
      const update = this.db.prepare(`UPDATE ${table} SET details_json = ? WHERE id = ?`);
      for (const row of rows) {
        try {
          update.run(json(JSON.parse(row.details_json)), row.id);
        } catch {
          // 无效的旧 JSON 保持原样，避免破坏运行历史。
        }
      }
    }
  }

  hasSuccessfulRun(localDate) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM runs WHERE local_date = ? AND status = 'success' LIMIT 1")
        .get(localDate),
    );
  }

  beginRun(localDate) {
    const result = this.db
      .prepare("INSERT INTO runs(local_date, started_at, status) VALUES (?, ?, 'running')")
      .run(localDate, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  finishRun(runId, { status, checkedIn = null, message = null, details = null }) {
    this.db
      .prepare(
        `UPDATE runs
         SET finished_at = ?, status = ?, checked_in = ?, message = ?, details_json = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), status, checkedIn == null ? null : Number(checkedIn), message, json(details), runId);
  }

  log(runId, level, event, message, details = null) {
    this.db
      .prepare(
        `INSERT INTO logs(run_id, created_at, level, event, message, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, new Date().toISOString(), level, event, message, json(details));
  }

  recentRuns(limit = 10) {
    return this.db
      .prepare(
        `SELECT id, local_date, started_at, finished_at, status, checked_in, message
         FROM runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  recentLogs(limit = 1000) {
    return this.db
      .prepare(
        `SELECT logs.id, logs.run_id, logs.created_at, logs.level, logs.event,
                logs.message, logs.details_json, runs.local_date, runs.status AS run_status
         FROM logs
         LEFT JOIN runs ON runs.id = logs.run_id
         ORDER BY logs.created_at DESC, logs.id DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  saveAccountSnapshot(snapshot) {
    const capturedAt = snapshot.updatedAt || snapshot.capturedAt || new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO account_snapshots(
          captured_at, balance, used, request_count, quota_per_unit, currency
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        capturedAt,
        Number(snapshot.balance || 0),
        Number(snapshot.used || 0),
        Number(snapshot.requestCount || 0),
        Number(snapshot.quotaPerUnit || 500000),
        snapshot.currency || "",
      );
    return Number(result.lastInsertRowid);
  }

  latestAccountSnapshot() {
    const row = this.db
      .prepare(
        `SELECT captured_at, balance, used, request_count, quota_per_unit, currency
         FROM account_snapshots ORDER BY id DESC LIMIT 1`,
      )
      .get();
    if (!row) return null;
    return {
      capturedAt: row.captured_at,
      updatedAt: row.captured_at,
      balance: row.balance,
      used: row.used,
      requestCount: row.request_count,
      quotaPerUnit: row.quota_per_unit,
      currency: row.currency,
    };
  }

  close() {
    this.db.close();
  }
}
