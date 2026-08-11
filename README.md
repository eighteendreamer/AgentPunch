# Agent Router 自动签到

面向普通用户的完整安装与使用说明见：[操作手册](docs/操作手册.md)。

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

计划任务包含两个触发器：用户登录时、每天 09:00。SQLite 幂等检查保证当天成功后再次触发会直接跳过。

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
