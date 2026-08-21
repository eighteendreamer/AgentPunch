import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";

// GitHub 仓库配置
// 可以在这里修改为你的实际仓库地址
// 也可以在 settings.json 中设置 githubOwner 和 githubRepo 来覆盖
const DEFAULT_GITHUB_OWNER = "eighteendreamer";
const DEFAULT_GITHUB_REPO = "AgentPunch";

function getGithubConfig() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(
      process.env.AGENT_ROUTER_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "AgentRouterCheckin"),
      "settings.json"
    ), "utf8"));
    return {
      owner: settings.githubOwner || DEFAULT_GITHUB_OWNER,
      repo: settings.githubRepo || DEFAULT_GITHUB_REPO,
    };
  } catch {
    return { owner: DEFAULT_GITHUB_OWNER, repo: DEFAULT_GITHUB_REPO };
  }
}

function getReleaseApi() {
  const { owner, repo } = getGithubConfig();
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

/**
 * 比较语义化版本号
 * 返回: 1 表示 remote 更新, 0 表示相同, -1 表示 local 更新
 */
function compareVersions(local, remote) {
  const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
  const [a1, a2, a3] = parse(local);
  const [b1, b2, b3] = parse(remote);
  if (a1 !== b1) return a1 < b1 ? 1 : 0;
  if (a2 !== b2) return a2 < b2 ? 1 : 0;
  if (a3 !== b3) return a3 < b3 ? 1 : 0;
  return 0;
}

/**
 * 从 GitHub API 获取最新 release 信息
 */
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const request = https.get(getReleaseApi(), {
      headers: {
        "User-Agent": "AgentPunch-Desktop-Updater",
        Accept: "application/vnd.github+json",
      },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub API 返回 ${response.statusCode}`));
          return;
        }
        try {
          const release = JSON.parse(data);
          resolve(release);
        } catch (error) {
          reject(new Error("无法解析 GitHub Release 信息"));
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(15_000, () => {
      request.destroy();
      reject(new Error("检查更新超时，请检查网络"));
    });
  });
}

/**
 * 查找 release 中的 Windows 安装包资源
 */
function findInstallerAsset(release) {
  const assets = release.assets || [];
  // 查找 NSIS 安装包 (.exe)
  return assets.find(
    (asset) => /\.exe$/i.test(asset.name) && /setup|install|agentpunch/i.test(asset.name),
  ) || assets.find((asset) => /\.exe$/i.test(asset.name));
}

/**
 * 检查是否有新版本
 */
export async function checkForUpdates(currentVersion) {
  const release = await fetchLatestRelease();
  const latestVersion = release.tag_name || "";
  if (!latestVersion) {
    return { hasUpdate: false, latestVersion: currentVersion, error: "无法获取最新版本号" };
  }

  const hasUpdate = compareVersions(currentVersion, latestVersion) > 0;
  if (!hasUpdate) {
    return { hasUpdate: false, latestVersion };
  }

  const installer = findInstallerAsset(release);
  if (!installer) {
    return {
      hasUpdate: false,
      latestVersion,
      error: "新版本未找到 Windows 安装包",
    };
  }

  return {
    hasUpdate: true,
    latestVersion,
    downloadUrl: installer.browser_download_url,
    fileSize: installer.size,
    releaseNotes: release.body || "",
    releaseUrl: release.html_url,
  };
}

/**
 * 下载安装包到临时目录
 * @param {string} url 下载地址
 * @param {(progress: number) => void} onProgress 进度回调 (0-100)
 * @returns {Promise<string>} 下载后的文件路径
 */
export function downloadInstaller(url, onProgress) {
  return new Promise((resolve, reject) => {
    const tempDir = app.getPath("temp");
    const fileName = `AgentPunch-Update-${Date.now()}.exe`;
    const filePath = path.join(tempDir, fileName);
    const fileStream = fs.createWriteStream(filePath);

    const handleRedirect = (targetUrl) => {
      const request = https.get(targetUrl, {
        headers: { "User-Agent": "AgentPunch-Desktop-Updater" },
      }, (response) => {
        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            handleRedirect(redirectUrl);
            return;
          }
        }
        if (response.statusCode !== 200) {
          reject(new Error(`下载失败：HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers["content-length"] || "0", 10);
        let receivedBytes = 0;
        let lastReportedPercent = -1;

        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) {
            const percent = Math.floor((receivedBytes / totalBytes) * 100);
            if (percent !== lastReportedPercent) {
              lastReportedPercent = percent;
              onProgress(percent);
            }
          }
        });

        response.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(() => resolve(filePath));
        });
      });

      request.on("error", (error) => {
        fs.rmSync(filePath, { force: true });
        reject(error);
      });

      request.setTimeout(5 * 60_000, () => {
        request.destroy();
        fs.rmSync(filePath, { force: true });
        reject(new Error("下载超时"));
      });
    };

    handleRedirect(url);
  });
}

/**
 * 运行安装包并退出当前应用
 * @param {string} installerPath 安装包路径
 */
export function installUpdate(installerPath) {
  // 启动 NSIS 安装程序（静默模式），然后退出当前应用
  // 安装完成后，NSIS 会自动启动新版本
  const child = spawn(installerPath, ["/S"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  // 给安装程序一点时间启动，然后退出
  setTimeout(() => {
    app.quit();
  }, 1000);
}
