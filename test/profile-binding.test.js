import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { githubLoginPageSettled, githubSessionFromCookies, persistentGithubCookies, replaceBrowserProfile } from "../src/profile-binding.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpunch-profile-"));
  const currentProfileDir = path.join(root, "browser-profile");
  const pendingProfileDir = path.join(root, "browser-profile.pending");
  const previousProfileDir = path.join(root, "browser-profile.previous");
  fs.mkdirSync(currentProfileDir);
  fs.mkdirSync(pendingProfileDir);
  fs.writeFileSync(path.join(currentProfileDir, "account.txt"), "old");
  fs.writeFileSync(path.join(pendingProfileDir, "account.txt"), "new");
  return { root, currentProfileDir, pendingProfileDir, previousProfileDir };
}

test("new browser profile replaces the old profile only after validation", () => {
  const paths = fixture();
  try {
    replaceBrowserProfile({ ...paths, finalize: () => {} });
    assert.equal(fs.readFileSync(path.join(paths.currentProfileDir, "account.txt"), "utf8"), "new");
    assert.equal(fs.existsSync(paths.pendingProfileDir), false);
    assert.equal(fs.existsSync(paths.previousProfileDir), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("old browser profile is restored when finalization fails", () => {
  const paths = fixture();
  try {
    assert.throws(() => replaceBrowserProfile({ ...paths, finalize: () => { throw new Error("failed"); } }), /failed/);
    assert.equal(fs.readFileSync(path.join(paths.currentProfileDir, "account.txt"), "utf8"), "old");
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("GitHub login is detected from authenticated cookies without waiting for a URL redirect", () => {
  assert.deepEqual(githubSessionFromCookies([
    { name: "logged_in", value: "yes" },
    { name: "user_session", value: "session-value" },
    { name: "dotcom_user", value: "agent%2Duser" },
  ]), { username: "agent-user" });
  assert.equal(githubSessionFromCookies([{ name: "logged_in", value: "no" }]), null);
});

test("GitHub login is not settled while login or 2FA pages are still active", () => {
  assert.equal(githubLoginPageSettled("https://github.com/login"), false);
  assert.equal(githubLoginPageSettled("https://github.com/sessions/two-factor/app"), false);
  assert.equal(githubLoginPageSettled("https://github.com/settings/profile"), true);
  assert.equal(githubLoginPageSettled("https://example.com/settings/profile"), false);
});

test("GitHub authentication cookies are rewritten as persistent without including unrelated cookies", () => {
  const cookies = persistentGithubCookies([
    { name: "user_session", value: "session", domain: "github.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "dotcom_user", value: "user", domain: ".github.com", path: "/", expires: 2000000000, httpOnly: false, secure: true, sameSite: "Lax" },
    { name: "tracking", value: "ignored", domain: ".github.com", path: "/", expires: 2000000000 },
  ], 1000000000);
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].name, "user_session");
  assert.equal(cookies[0].expires, 1002592000);
  assert.equal(cookies[1].expires, 2000000000);
});
