import fs from "node:fs";

export function githubSessionFromCookies(cookies) {
  const session = cookies.find((cookie) => cookie.name === "user_session" && cookie.value);
  const loggedIn = cookies.find((cookie) => cookie.name === "logged_in");
  if (!session || (loggedIn && loggedIn.value !== "yes")) return null;
  const username = cookies.find((cookie) => cookie.name === "dotcom_user")?.value;
  return { username: username ? decodeURIComponent(username) : null };
}

export function githubLoginPageSettled(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return false;
    return !/^\/(?:login|session|sessions|two-factor)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function persistentGithubCookies(cookies, nowSeconds = Date.now() / 1000) {
  const minimumExpiry = Math.floor(nowSeconds + 30 * 24 * 60 * 60);
  return cookies
    .filter((cookie) => /(^|\.)github\.com$/i.test(cookie.domain))
    .filter((cookie) => ["user_session", "__Host-user_session_same_site", "logged_in", "dotcom_user"].includes(cookie.name))
    .map(({ name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite, partitionKey }) => ({
      name,
      value,
      domain,
      path: cookiePath || "/",
      expires: expires > nowSeconds ? expires : minimumExpiry,
      httpOnly: Boolean(httpOnly),
      secure: Boolean(secure),
      sameSite: sameSite || "Lax",
      ...(partitionKey ? { partitionKey } : {}),
    }));
}

export function replaceBrowserProfile({ currentProfileDir, pendingProfileDir, previousProfileDir, finalize = () => {} }) {
  if (!fs.existsSync(pendingProfileDir)) throw new Error("新的浏览器配置不存在，无法完成账号切换");

  fs.rmSync(previousProfileDir, { recursive: true, force: true });
  let previousMoved = false;
  let pendingMoved = false;
  try {
    if (fs.existsSync(currentProfileDir)) {
      fs.renameSync(currentProfileDir, previousProfileDir);
      previousMoved = true;
    }
    fs.renameSync(pendingProfileDir, currentProfileDir);
    pendingMoved = true;
    finalize();
    fs.rmSync(previousProfileDir, { recursive: true, force: true });
  } catch (error) {
    if (pendingMoved) fs.rmSync(currentProfileDir, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previousProfileDir)) {
      fs.renameSync(previousProfileDir, currentProfileDir);
    }
    throw error;
  }
}
