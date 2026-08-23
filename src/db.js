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
        site TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        balance REAL NOT NULL,
        used REAL NOT NULL,
        request_count INTEGER NOT NULL,
        quota_per_unit REAL NOT NULL,
        currency TEXT NOT NULL,
        site TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_captured_at
        ON account_snapshots(captured_at DESC);
    `);
    // 为旧数据库迁移：添加 site 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE logs ADD COLUMN site TEXT`);
    } catch {
      // 列已存在，忽略
    }
    // 创建 site 索引（在 ALTER TABLE 之后，确保列存在）
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_site ON logs(site)`);
    // 迁移：为 account_snapshots 添加 site 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE account_snapshots ADD COLUMN site TEXT`);
    } catch {
      // 列已存在，忽略
    }
    // 创建 account_snapshots site 索引（在 ALTER TABLE 之后，确保列存在）
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_account_snapshots_site ON account_snapshots(site, captured_at DESC)`);
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

  log(runId, level, event, message, details = null, site = null) {
    this.db
      .prepare(
        `INSERT INTO logs(run_id, created_at, level, event, message, details_json, site)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, new Date().toISOString(), level, event, message, json(details), site);
  }

  recentRuns(limit = 10) {
    return this.db
      .prepare(
        `SELECT id, local_date, started_at, finished_at, status, checked_in, message, details_json
         FROM runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  recentLogs(limit = 1000, site = null) {
    if (site) {
      return this.db
        .prepare(
          `SELECT logs.id, logs.run_id, logs.created_at, logs.level, logs.event,
                  logs.message, logs.details_json, logs.site, runs.local_date, runs.status AS run_status
           FROM logs
           LEFT JOIN runs ON runs.id = logs.run_id
           WHERE logs.site = ?
           ORDER BY logs.created_at DESC, logs.id DESC
           LIMIT ?`,
        )
        .all(site, limit);
    }
    return this.db
      .prepare(
        `SELECT logs.id, logs.run_id, logs.created_at, logs.level, logs.event,
                logs.message, logs.details_json, logs.site, runs.local_date, runs.status AS run_status
         FROM logs
         LEFT JOIN runs ON runs.id = logs.run_id
         ORDER BY logs.created_at DESC, logs.id DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  saveAccountSnapshot(snapshot, site = null) {
    const capturedAt = snapshot.updatedAt || snapshot.capturedAt || new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO account_snapshots(
          captured_at, balance, used, request_count, quota_per_unit, currency, site
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        capturedAt,
        Number(snapshot.balance || 0),
        Number(snapshot.used || 0),
        Number(snapshot.requestCount || 0),
        Number(snapshot.quotaPerUnit || 500000),
        snapshot.currency || "",
        site,
      );
    return Number(result.lastInsertRowid);
  }

  latestAccountSnapshot(site = null) {
    if (site) {
      const row = this.db
        .prepare(
          `SELECT captured_at, balance, used, request_count, quota_per_unit, currency, site
           FROM account_snapshots WHERE site = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(site);
      if (!row) return null;
      return {
        capturedAt: row.captured_at,
        updatedAt: row.captured_at,
        balance: row.balance,
        used: row.used,
        requestCount: row.request_count,
        quotaPerUnit: row.quota_per_unit,
        currency: row.currency,
        site: row.site,
      };
    }
    // 无参数时返回所有站点最新快照
    const rows = this.db
      .prepare(
        `SELECT DISTINCT site FROM account_snapshots WHERE site IS NOT NULL`,
      )
      .all();
    if (rows.length === 0) {
      // 兼容旧数据：没有 site 字段时返回最新一条
      const fallback = this.db
        .prepare(
          `SELECT captured_at, balance, used, request_count, quota_per_unit, currency
           FROM account_snapshots ORDER BY id DESC LIMIT 1`,
        )
        .get();
      if (!fallback) return null;
      return {
        capturedAt: fallback.captured_at,
        updatedAt: fallback.captured_at,
        balance: fallback.balance,
        used: fallback.used,
        requestCount: fallback.request_count,
        quotaPerUnit: fallback.quota_per_unit,
        currency: fallback.currency,
      };
    }
    // 返回各站点最新快照
    const snapshots = {};
    for (const { site: siteId } of rows) {
      const row = this.db
        .prepare(
          `SELECT captured_at, balance, used, request_count, quota_per_unit, currency, site
           FROM account_snapshots WHERE site = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(siteId);
      if (row) {
        snapshots[row.site] = {
          capturedAt: row.captured_at,
          updatedAt: row.captured_at,
          balance: row.balance,
          used: row.used,
          requestCount: row.request_count,
          quotaPerUnit: row.quota_per_unit,
          currency: row.currency,
          site: row.site,
        };
      }
    }
    return snapshots;
  }

  close() {
    this.db.close();
  }
}
