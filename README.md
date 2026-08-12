# Agent Router 自动签到

面向普通用户的完整安装与使用说明见：[操作手册](docs/操作手册.md)。

## 桌面端开发预览

桌面端 MVP 位于 `apps/desktop`，目前包含首页状态、官方账户余额与历史消耗、立即签到、运行历史、计划任务开关、GitHub 重新绑定和设置管理。余额来自 `GET /api/user/self` 的 `quota` 字段，并按站点 `/api/status` 返回的 `quota_per_unit` 动态换算。

首次安装桌面端依赖：

```powershell
cd apps\desktop
npm install
node node_modules\electron\install.js
```

启动开发模式：

```powershell
npm run desktop:dev
```

构建并启动：

```powershell
npm run desktop:start
```

每天通过独立 Chrome 配置中已有的 GitHub 登录态，先清理 `https://ps.air-outer.com` 的站点会话，再完成一次 GitHub OAuth 登录。该站点在登录成功时执行每日签到。

站点的 GitHub OAuth 应用会把默认回调指向 `https://agentrouter.org`。脚本会在浏览器准备跳转时截获 OAuth `code/state`，改投到 `https://ps.air-outer.com/oauth/github` 完成登录，因此日常签到不需要访问主域名；GitHub 会话不会被清理。

## 安全设计

- GitHub 密码、2FA 种子和 Cookie 不写入 SQLite，也不写入项目文件。
- GitHub 会话由 Chrome 配置保存，并使用 Windows 的浏览器凭据保护机制。
- SQLite 仅保存运行记录、签到结果和诊断日志，默认位于 `%LOCALAPPDATA%\AgentRouterCheckin\checkin.sqlite3`。
- 不要把 2FA 种子提交到 `2fa.fun` 或任何第三方验证码网页；请使用 GitHub Mobile、认证器或密码管理器在本机生成验证码。

## 安装

```powershell
npm install
npm run doctor
npm run setup
npm run install-task
```

`npm run setup` 会打开一个独立 Chrome 窗口。首次在其中手动登录 GitHub 并完成 2FA，之后脚本复用这个浏览器配置。

桌面端“切换账号”会使用全新的临时 Chrome 配置登录并验证新账号。新账号完成 GitHub 登录和 AgentRouter OAuth 后才会替换现有配置；关闭窗口、登录超时或验证失败都不会破坏原账号登录状态。

安装版启动时会检查现有 Windows 自动任务。如果发现任务仍指向源码目录、`node.exe` 或 PowerShell，会保留原执行时间并自动迁移为隐藏运行的 `AgentPunch.exe --background-checkin`，避免签到时弹出终端窗口。

## 卸载与本地数据

通过 Windows“已安装的应用”卸载 AgentPunch 时，卸载程序始终删除 `AgentRouterDailyCheckin` 自动执行任务，确保卸载后不再运行每日签到。

本地数据保存在 `%LOCALAPPDATA%\AgentRouterCheckin`，包含独立 Chrome 登录配置、SQLite 签到历史和余额快照、设置、日志、账号元数据以及迁移前备份。卸载时会弹出确认框询问是否同时删除本地账号与历史数据，默认选择“否”；选择“是”后彻底删除。删除不可恢复，如需换机或保留账号，请先在设置页导出加密迁移包。

安装器更新缓存位于 `%LOCALAPPDATA%\agentpunch-desktop-updater`，不属于用户账号数据，正常卸载时始终删除。

计划任务包含两个触发器：用户登录时、每天 09:00。SQLite 幂等检查保证当天成功后再次触发会直接跳过。

计划任务由 Node.js 生成 Windows Task Scheduler XML，并通过系统自带的 `schtasks.exe` 管理，不依赖 PowerShell。命令行自定义时间可使用 `npm run install-task -- 10:30`，桌面端也可以直接在设置页修改。

## 手动运行与排错

```powershell
npm run run
npm run doctor
```

退出码：`0` 表示成功或当天已成功；`2` 表示 GitHub 登录态失效，需要重新运行 `npm run setup`；其他非零值表示网络或站点错误。

如需临时显示浏览器窗口：

```powershell
$env:AGENT_ROUTER_HEADLESS='false'
npm run run
```

仅在调试时强制忽略当天成功记录：

```powershell
$env:AGENT_ROUTER_FORCE='true'
npm run run
```

卸载计划任务：

```powershell
npm run uninstall-task
```

## 迁移到另一台电脑

在桌面端打开“设置 → 账号迁移”：

1. 在旧电脑点击“导出”，设置至少 8 位迁移密码并保存 `.agentpunch-backup` 文件。
2. 将迁移包复制到新电脑。迁移密码请通过另一种安全方式传递，不要和文件放在一起。
3. 在新电脑安装 AgentPunch，进入“设置 → 账号迁移”，点击“导入”并输入原迁移密码。
4. 导入后重新开启自动签到任务；建议立即手动签到一次，确认 GitHub 没有触发异地登录验证。

迁移包使用 scrypt 派生密钥和 AES-256-GCM 加密，包含 GitHub 登录 Cookie、应用设置、签到历史及余额快照，不包含 GitHub 密码或 2FA 密钥。Windows 任务计划不会从旧电脑直接复制。如果 GitHub 因设备或网络变化撤销会话，仍需在新电脑重新完成一次 GitHub 验证。
