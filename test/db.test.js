import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckinDatabase } from "../src/db.js";

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
