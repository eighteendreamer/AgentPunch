import assert from "node:assert/strict";
import test from "node:test";
import { checkinInternals } from "../src/checkin.js";

test("GitHub connection reset errors are reduced to a useful message", () => {
  const error = new Error("page.goto: net::ERR_CONNECTION_RESET at https://github.com/login/oauth/authorize?state=secret\nCall log: ...");
  const message = checkinInternals.navigationErrorMessage(error, "GitHub OAuth");
  assert.equal(message, "访问 GitHub OAuth 时连接被重置，已自动重试 3 次，请检查网络后重试");
  assert.doesNotMatch(message, /state=|Call log|github\.com\/login/);
});

test("OAuth callback matching accepts only the expected AgentRouter callback", () => {
  assert.equal(checkinInternals.isAgentRouterCallback("https://agentrouter.org/oauth/github?code=redacted&state=redacted"), true);
  assert.equal(checkinInternals.isAgentRouterCallback("https://agentrouter.org/api/oauth/github?code=redacted"), false);
  assert.equal(checkinInternals.isAgentRouterCallback("https://example.com/oauth/github?code=redacted"), false);
});

test("AgentRouter session cookie is remapped to the domestic domain without exposing other cookies", () => {
  const cookie = checkinInternals.domesticSessionCookie({
    name: "session", value: "secret", domain: "agentrouter.org", path: "/", expires: 123,
    httpOnly: true, secure: true, sameSite: "Lax",
  }, "https://ps.air-outer.com");
  assert.deepEqual(cookie, {
    name: "session", value: "secret", domain: "ps.air-outer.com", path: "/", expires: 123,
    httpOnly: true, secure: true, sameSite: "Lax",
  });
  assert.equal(checkinInternals.domesticSessionCookie({ name: "other" }, "https://ps.air-outer.com"), null);
});
