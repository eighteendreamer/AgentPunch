import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function json(value) {
  return value == null ? null : JSON.stringify(value);
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
    `);
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

  close() {
    this.db.close();
  }
}
