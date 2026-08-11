import assert from "node:assert/strict";
import test from "node:test";
import { backupInternals } from "../src/backup.js";

test("migration payload is encrypted and authenticated", () => {
  const payload = { settings: { dailyTime: "09:00" }, github: { cookies: [{ name: "user_session", value: "secret" }] } };
  const encrypted = backupInternals.encryptPayload(payload, "correct horse battery staple");
  assert.equal(JSON.stringify(encrypted).includes("user_session"), false);
  assert.deepEqual(backupInternals.decryptPayload(encrypted, "correct horse battery staple"), payload);
  assert.throws(() => backupInternals.decryptPayload(encrypted, "wrong password"), /密码错误|损坏/);
});

test("migration only keeps GitHub cookies", () => {
  const cookies = backupInternals.portableCookies([
    { name: "user_session", value: "a", domain: ".github.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "other", value: "b", domain: ".example.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
  ]);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, "user_session");
});
