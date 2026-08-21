import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleUser,
  Clock3,
  Database,
  Download,
  ExternalLink,
  History,
  Home,
  LoaderCircle,
  Logs,
  LockKeyhole,
  Play,
  RefreshCw,
  Settings,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import "./styles.css";

const api = window.agentPunch;

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function statusLabel(status) {
  return { success: "成功", failure: "失败", auth_required: "需要登录", running: "运行中" }[status] || status || "暂无";
}

function siteLabel(site) {
  if (!site) return "全局";
  return { agentrouter: "AgentRouter", justwoker: "JustDoWork" }[site] || site;
}

function displayRunMessage(message) {
  if (!message) return "—";
  if (/ERR_CONNECTION_RESET/i.test(message)) return "访问 GitHub OAuth 时连接被重置，请检查网络后重试";
  if (/ERR_(?:CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED)|page\.goto.*Timeout/i.test(message)) {
    return "访问 GitHub OAuth 时网络连接不稳定，请检查网络后重试";
  }
  if (/npm run setup|GitHub 登录态已失效|GitHub 登录状态已失效/i.test(message)) return "GitHub 登录状态不可用，请在设置页点击“切换账号”重新绑定";
  return message;
}

function Sidebar({ page, setPage }) {
  const items = [
    ["home", Home, "首页"],
    ["history", History, "运行历史"],
    ["settings", Settings, "设置"],
  ];
  return (
    <aside className="sidebar">
      <div className="brand"><img className="brand-logo" src="./agentpunch-logo.png" alt="AgentPunch" /><span>AgentPunch</span></div>
      <nav>
        {items.map(([id, Icon, label]) => (
          <button key={id} className={page === id ? "nav-item active" : "nav-item"} onClick={() => setPage(id)}>
            <Icon size={18} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot"><ShieldCheck size={17} /><span>本地安全运行</span></div>
    </aside>
  );
}

function Toggle({ checked, onChange, disabled }) {
  return <button disabled={disabled} className={checked ? "toggle on" : "toggle"} onClick={() => onChange(!checked)} aria-pressed={checked}><span /></button>;
}

function HomePage({ status, balance, balanceBusy, busy, setupBusy, setupPhase, onRun, onTaskToggle, onSetup }) {
  const latest = status?.latestRun;
  const success = status?.successfulToday;
  const taskOn = status?.task?.installed;
  const githubUsername = status?.account?.githubUsername;
  // balance 是 { agentrouter: { balance, used, currency, ... }, justwoker: { ... } } 格式
  const siteBalances = balance?.ok ? balance.data : (status?.balance || {});
  const siteList = Object.entries(siteBalances || {}).filter(([, v]) => v && v.balance !== undefined);
  const hasAnyBalance = siteList.length > 0;
  return (
    <main className="page home-page">
      <header className="page-header">
        <div><h1>首页</h1><p>查看签到、余额和自动任务状态。</p></div>
      </header>

      <section className={success ? "hero-status success" : "hero-status pending"}>
        <div className="status-overview">
          <div className="status-symbol">{busy ? <LoaderCircle className="spin" size={42} /> : success ? <CheckCircle2 size={46} /> : <Clock3 size={44} />}</div>
          <div className="status-copy">
            <span className="status-kicker">{busy ? "正在运行" : success ? "状态正常" : "等待签到"}</span>
            <h2>{busy ? "正在完成 GitHub 登录签到" : success ? "今天已经签到" : "今天还没有成功记录"}</h2>
            <p>{busy ? "正在清理旧会话并完成安全 OAuth 登录，请稍候。" : latest ? `${formatDate(latest.finished_at || latest.started_at)} · ${displayRunMessage(latest.message || statusLabel(latest.status))}` : "完成首次绑定后，AgentPunch 会自动处理每日签到。"}</p>
          </div>
        </div>
        <div className="hero-side">
          <div className="balance-summary">
            {hasAnyBalance ? siteList.map(([siteId, snap]) => (
              <div key={siteId} className="balance-item">
                <span className="balance-site-name">{siteLabel(siteId)}</span>
                <strong>{snap.currency}{snap.balance != null ? snap.balance.toFixed(2) : "—"}</strong>
                <small>消耗 {snap.currency}{snap.used != null ? snap.used.toFixed(2) : "—"}</small>
              </div>
            )) : <div className="balance-item"><span>当前余额</span><strong>—</strong><small>{balanceBusy ? "正在后台获取余额" : balance?.error || (status?.initialized ? "余额尚未获取" : "绑定账号后可读取")}</small></div>}
            {balanceBusy && <div className="balance-updating"><LoaderCircle className="spin" size={13} />更新中</div>}
          </div>
          {!success && <button className="primary-button" disabled={busy || setupBusy} onClick={onRun}>{busy || setupBusy ? <LoaderCircle className="spin" size={18} /> : <Play size={18} fill="currentColor" />}{setupBusy ? "账号切换中" : "立即签到"}</button>}
        </div>
      </section>

      <section className="automation-section">
        <div className="automation-heading">
          <div><h3>自动签到</h3><p>由 Windows 任务计划程序负责，应用关闭后仍可运行。</p></div>
          <div className="automation-switch"><span>{taskOn ? "已开启" : "未开启"}</span><Toggle checked={taskOn} onChange={onTaskToggle} /></div>
        </div>
        <div className="automation-facts">
          <div className="fact-item"><CalendarClock size={20} /><span><small>下次运行</small><strong>{taskOn ? status?.task?.nextRunTime ? formatDate(status.task.nextRunTime) : `每天 ${status?.settings?.dailyTime}` : "未启用"}</strong></span></div>
          <div className="fact-item"><CircleUser size={20} /><span><small>GitHub 登录</small><strong>{setupBusy ? setupPhase || "正在绑定" : status?.initialized ? githubUsername ? `已绑定 @${githubUsername}` : "已绑定" : status?.sessionRecoverable ? "可恢复" : "尚未绑定"}</strong></span>{!status?.initialized && (status?.sessionRecoverable ? <button className="text-button" disabled={busy || setupBusy} onClick={onRun}>{busy || setupBusy ? "恢复中" : "恢复登录"}</button> : <button className="text-button" disabled={setupBusy} onClick={onSetup}>{setupBusy ? "处理中" : "去绑定"}</button>)}</div>
          <div className="fact-item"><Database size={20} /><span><small>运行数据</small><strong>仅保存在本机</strong></span></div>
        </div>
        <div className="automation-note"><ShieldCheck size={16} /><span>密码、Cookie 与 2FA 密钥不会写入数据库。</span></div>
      </section>
    </main>
  );
}

function extractSiteTags(run) {
  if (!run.details_json) return [];
  try {
    const details = JSON.parse(run.details_json);
    if (Array.isArray(details.sites)) {
      return details.sites.map((s) => ({ id: s.site, name: siteLabel(s.site), status: s.status }));
    }
  } catch {}
  return [];
}

function HistoryPage({ runs }) {
  return (
    <main className="page">
      <header className="page-header"><div><h1>运行历史</h1><p>查看每次自动与手动签到的执行结果。</p></div></header>
      <section className="table-section">
        <div className="table-head"><span>日期</span><span>开始时间</span><span>结果</span><span>站点</span><span>签到</span><span>说明</span></div>
        {(runs || []).map((run) => {
          const siteTags = extractSiteTags(run);
          return <div className="table-row" key={run.id}>
            <span className="history-date">{run.local_date}</span>
            <span className="history-time">{formatDate(run.started_at)}</span>
            <span><i className={`mini-dot ${run.status}`} /><b className={`history-result ${run.status}`}>{statusLabel(run.status)}</b></span>
            <span className="history-sites">{siteTags.length ? siteTags.map((t) => <span key={t.id} className={`site-tag ${t.status}`}>{t.name}</span>) : "—"}</span>
            <span className={run.checked_in ? "checkin-result yes" : "checkin-result"}>{run.checked_in ? "已签到" : "—"}</span>
            <span className="history-message" title={run.message}>{displayRunMessage(run.message)}</span>
          </div>;
        })}
        {!runs?.length && <div className="empty-row large">还没有运行记录</div>}
      </section>
    </main>
  );
}

function SettingsPage({ status, setupBusy, setupPhase, onSave, onSetup, onOpenData, onMigration, onOpenLogs, onCheckUpdate, onRun, busy }) {
  const [form, setForm] = useState(status?.settings || { dailyTime: "09:00", headless: true });
  useEffect(() => setForm(status?.settings || form), [status?.settings]);
  const dirty =
    form.dailyTime !== status?.settings?.dailyTime ||
    form.headless !== status?.settings?.headless;
  const githubUsername = status?.account?.githubUsername;
  return (
    <main className="page">
      <header className="page-header settings-header">
        <div><h1>设置</h1><p>管理自动执行方式、GitHub 登录和本地数据。</p></div>
        <button className="primary-button" disabled={!dirty} onClick={() => onSave(form)}><Check size={17} />保存更改</button>
      </header>
      <section className="settings-grid">
        <div className="settings-column">
          <div className="settings-section-heading"><CalendarClock size={20} /><div><h3>自动化</h3><p>控制每日签到的执行时间和浏览器行为。</p></div></div>
          <div className="setting-group">
            <div className="setting-row"><div><strong>每日执行时间</strong><p>错过时间后会在下次可用时补运行。</p></div><input type="time" value={form.dailyTime} onChange={(e) => setForm({ ...form, dailyTime: e.target.value })} /></div>
            <div className="setting-row"><div><strong>后台运行浏览器</strong><p>关闭后，签到时会显示 Chrome 窗口。</p></div><Toggle checked={form.headless} onChange={(value) => setForm({ ...form, headless: value })} /></div>
            <div className="setting-row"><div><strong>运行日志</strong><p>按时间查看签到与 OAuth 执行过程。</p></div><button className="secondary-button" onClick={onOpenLogs}>查看日志 <ChevronRight size={15} /></button></div>
          </div>
        </div>
        <div className="settings-column account-column">
          <div className="settings-section-heading"><CircleUser size={20} /><div><h3>账户与数据</h3><p>维护 GitHub 登录状态和本机文件。</p></div></div>
          <div className="setting-group">
            <div className="setting-row"><div><strong>GitHub 账号</strong><p><span className={status?.initialized ? "account-dot connected" : "account-dot"} />{setupBusy ? setupPhase || "正在启动 GitHub 绑定流程。" : status?.initialized ? `${githubUsername ? `已绑定 @${githubUsername}，` : "已绑定，"}会话由 Windows 加密保存在本机。` : status?.sessionRecoverable ? "登录状态需恢复。点击「恢复登录」运行一次签到即可自动恢复。" : status?.authState?.valid === false ? "登录状态不可用，请重新绑定。" : "尚未完成首次绑定。"}</p></div>{status?.sessionRecoverable ? <button className="secondary-button" disabled={busy || setupBusy} onClick={onRun}>{busy || setupBusy ? <LoaderCircle className="spin" size={15} /> : null}{busy || setupBusy ? "恢复中" : "恢复登录"} {!busy && !setupBusy && <ExternalLink size={15} />}</button> : <button className="secondary-button" disabled={setupBusy} onClick={onSetup}>{setupBusy ? <LoaderCircle className="spin" size={15} /> : null}{setupBusy ? setupPhase?.includes("验证") ? "验证中" : "登录中" : status?.initialized ? "切换账号" : "重新绑定"} {!setupBusy && <ExternalLink size={15} />}</button>}</div>
            <div className="setting-row"><div><strong>本地数据</strong><p className="path-text">{status?.dataDir}</p></div><button className="secondary-button" onClick={onOpenData}>打开目录 <ChevronRight size={15} /></button></div>
            <div className="setting-row migration-row"><div><strong>账号迁移</strong><p>加密导出 GitHub 登录状态、设置与运行历史。</p></div><div className="setting-actions"><button className="secondary-button" disabled={setupBusy} onClick={() => onMigration("import")}><Upload size={15} />导入</button><button className="secondary-button" onClick={() => onMigration("export")} disabled={setupBusy || !status?.initialized}><Download size={15} />导出</button></div></div>
            <div className="setting-row"><div><strong>检查更新</strong><p>从 GitHub 仓库检查并下载最新版本。</p></div><button className="secondary-button" onClick={onCheckUpdate}><RefreshCw size={15} />检查更新</button></div>
          </div>
        </div>
      </section>
      <div className="settings-footer">
        <div className="settings-security"><ShieldCheck size={16} /><span>密码和 2FA 密钥不会保存；GitHub 会话由 Windows 加密存储，不写入数据库。</span></div>
        <span className="app-version">AgentPunch v{status?.appVersion || "—"}</span>
      </div>
    </main>
  );
}

function LogDialog({ value, onClose, onRefresh }) {
  if (!value) return null;
  const levelLabel = { info: "信息", warn: "警告", error: "错误" };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="log-dialog" role="dialog" aria-modal="true" aria-labelledby="log-dialog-title">
      <header className="log-dialog-header">
        <div className="log-dialog-title"><span className="log-dialog-icon"><Logs size={20} /></span><div><h2 id="log-dialog-title">运行日志</h2><p>共 {value.logs.length} 条记录，按时间从新到旧排列。</p></div></div>
        <div className="log-dialog-actions"><button className="secondary-button" disabled={value.loading} onClick={onRefresh}>{value.loading ? <LoaderCircle className="spin" size={15} /> : null}刷新</button><button className="dialog-close static" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
      </header>
      {value.error ? <div className="log-dialog-error"><CircleAlert size={17} />{value.error}</div> : <div className="log-table-wrap">
        <div className="log-table">
          <div className="log-table-head"><span>时间</span><span>级别</span><span>站点</span><span>事件</span><span>运行</span><span>日志信息</span></div>
          {value.logs.map((log) => <div className="log-table-row" key={log.id}>
            <time dateTime={log.created_at}>{formatDate(log.created_at)}</time>
            <span><i className={`log-level-dot ${log.level}`} /><b className={`log-level ${log.level}`}>{levelLabel[log.level] || log.level}</b></span>
            <span className="log-site">{siteLabel(log.site)}</span>
            <code>{log.event || "—"}</code>
            <span className="log-run">{log.local_date ? `${log.local_date} · #${log.run_id}` : "系统"}</span>
            <details className="log-message"><summary>{displayRunMessage(log.message)}</summary>{log.details_json && <pre>{log.details_json}</pre>}</details>
          </div>)}
          {!value.logs.length && !value.loading && <div className="log-empty">暂无日志记录</div>}
          {value.loading && !value.logs.length && <div className="log-empty"><LoaderCircle className="spin" size={18} />正在读取日志</div>}
        </div>
      </div>}
    </section>
  </div>;
}

function UpdateDialog({ value, onClose, onDownload, onInstall }) {
  if (!value) return null;
  const { checking, hasUpdate, latestVersion, releaseNotes, releaseUrl, downloading, downloadProgress, downloaded, error } = value;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !checking && !downloading && onClose()}>
    <section className="migration-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <button className="dialog-close" disabled={checking || downloading} onClick={onClose} aria-label="关闭"><X size={18} /></button>
      <div className="dialog-icon"><RefreshCw size={23} /></div>
      {checking ? <>
        <h2 id="update-title">正在检查更新…</h2>
        <p>正在从 GitHub 获取最新版本信息。</p>
        <div className="update-loading"><LoaderCircle className="spin" size={28} /></div>
      </> : error ? <>
        <h2 id="update-title">检查更新失败</h2>
        <p className="update-error-text">{error}</p>
        <div className="dialog-actions"><button className="primary-button" onClick={onClose}>关闭</button></div>
      </> : hasUpdate ? <>
        <h2 id="update-title">发现新版本 v{latestVersion}</h2>
        <p>当前版本 v{value.currentVersion}，新版本已发布。</p>
        {releaseNotes && <div className="update-notes"><pre>{releaseNotes}</pre></div>}
        {downloading ? <>
          <div className="update-progress-bar"><div className="update-progress-fill" style={{ width: `${downloadProgress}%` }} /></div>
          <p className="update-progress-text">正在下载… {downloadProgress}%</p>
        </> : downloaded ? <>
          <div className="dialog-note"><ShieldCheck size={15} /><span>下载完成，点击安装后应用将关闭并启动安装程序。</span></div>
          <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>稍后</button><button className="primary-button" onClick={onInstall}><Download size={17} />立即安装</button></div>
        </> : <>
          <div className="dialog-note"><ShieldCheck size={15} /><span>下载安装包后，退出应用并自动启动安装程序。</span></div>
          <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>稍后</button><button className="primary-button" onClick={onDownload}><Download size={17} />下载更新</button></div>
          {releaseUrl && <a className="update-release-link" href="#" onClick={(e) => { e.preventDefault(); window.open(releaseUrl, "_blank"); }}>查看 Release 详情</a>}
        </>}
      </> : <>
        <h2 id="update-title">已是最新版本</h2>
        <p>当前版本 v{value.currentVersion}，无需更新。</p>
        <div className="dialog-actions"><button className="primary-button" onClick={onClose}>关闭</button></div>
      </>}
    </section>
  </div>;
}

function MigrationDialog({ value, onChange, onClose, onConfirm }) {
  if (!value) return null;
  const exporting = value.mode === "export";
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !value.busy && onClose()}>
    <section className="migration-dialog" role="dialog" aria-modal="true" aria-labelledby="migration-title">
      <button className="dialog-close" disabled={value.busy} onClick={onClose} aria-label="关闭"><X size={18} /></button>
      <div className="dialog-icon"><LockKeyhole size={23} /></div>
      <h2 id="migration-title">{exporting ? "导出账号迁移包" : "导入账号迁移包"}</h2>
      <p>{exporting ? "迁移包包含 GitHub 登录状态和本地数据，请设置一个只有你知道的密码。" : "输入创建迁移包时设置的密码，随后选择需要导入的文件。"}</p>
      <label><span>迁移密码</span><input autoFocus type="password" value={value.password} disabled={value.busy} onChange={(event) => onChange({ ...value, password: event.target.value, error: null })} placeholder="至少 8 个字符" /></label>
      {exporting && <label><span>再次输入密码</span><input type="password" value={value.confirmPassword} disabled={value.busy} onChange={(event) => onChange({ ...value, confirmPassword: event.target.value, error: null })} placeholder="再次确认迁移密码" /></label>}
      {value.error && <div className="dialog-error"><CircleAlert size={15} />{value.error}</div>}
      <div className="dialog-note"><ShieldCheck size={15} /><span>密码不会保存；忘记密码将无法恢复迁移包。</span></div>
      <div className="dialog-actions"><button className="secondary-button" disabled={value.busy} onClick={onClose}>取消</button><button className="primary-button" disabled={value.busy} onClick={onConfirm}>{value.busy ? <LoaderCircle className="spin" size={17} /> : exporting ? <Download size={17} /> : <Upload size={17} />}{value.busy ? "处理中" : exporting ? "选择位置并导出" : "选择文件并导入"}</button></div>
    </section>
  </div>;
}

function App() {
  const requestedPage = new URLSearchParams(location.search).get("page");
  const [page, setPage] = useState(["home", "history", "settings"].includes(requestedPage) ? requestedPage : "home");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState(null);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupPhase, setSetupPhase] = useState(null);
  const [migration, setMigration] = useState(null);
  const [updateDialog, setUpdateDialog] = useState(null);
  const [logDialog, setLogDialog] = useState(null);
  const [toast, setToast] = useState(null);
  const notify = (message, tone = "ok") => { setToast({ message, tone }); setTimeout(() => setToast(null), 3600); };
  const refresh = async () => {
    const next = await api.getStatus();
    setStatus(next);
    if (next.balance) setBalance({ ok: true, data: next.balance });
    return next;
  };
  async function refreshBalance(showToast = false) {
    setBalanceBusy(true);
    try {
      const result = await api.refreshBalance();
      if (result.ok) {
        setBalance(result);
        setStatus((current) => current ? { ...current, balance: result.data } : current);
      } else setBalance((current) => current?.ok ? current : { ok: false, error: result.error || "余额暂时无法更新" });
      if (showToast) notify(result.ok ? "余额已更新" : result.error || "余额暂时无法更新", result.ok ? "ok" : "error");
    } catch (error) {
      setBalance((current) => current?.ok ? current : { ok: false, error: "余额暂时无法更新" });
      if (showToast) notify("余额暂时无法更新", "error");
    } finally {
      setBalanceBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const next = await api.getStatus();
        if (!active) return;
        setStatus(next);
        if (next.balance) setBalance({ ok: true, data: next.balance });

        api.getTaskStatus().then((task) => {
          if (active) {
            setStatus((current) => current ? { ...current, task } : current);
            if (task.migratedFromLegacy) notify("已将旧版自动任务升级为隐藏运行模式");
          }
        }).catch(() => {});

        if (next.initialized && !next.balance) refreshBalance(false);

      } catch {
        if (active) notify("本地状态读取失败", "error");
      }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => api.onSetupProgress?.(({ message }) => setSetupPhase(message)), []);
  useEffect(() => api.onUpdateProgress?.(({ progress }) => {
    setUpdateDialog((current) => current ? { ...current, downloadProgress: progress } : current);
  }), []);

  async function checkUpdate() {
    setUpdateDialog({ checking: true, currentVersion: status?.appVersion || "—" });
    try {
      const result = await api.checkUpdate();
      if (result.ok) {
        setUpdateDialog({
          checking: false,
          hasUpdate: result.hasUpdate,
          latestVersion: result.latestVersion,
          releaseNotes: result.releaseNotes,
          releaseUrl: result.releaseUrl,
          currentVersion: status?.appVersion || "—",
          error: result.error || null,
          downloading: false,
          downloadProgress: 0,
          downloaded: false,
        });
      } else {
        setUpdateDialog({ checking: false, hasUpdate: false, currentVersion: status?.appVersion || "—", error: result.error || "检查更新失败" });
      }
    } catch (error) {
      setUpdateDialog({ checking: false, hasUpdate: false, currentVersion: status?.appVersion || "—", error: error.message || "检查更新失败" });
    }
  }
  async function downloadUpdate() {
    setUpdateDialog((current) => current ? { ...current, downloading: true, downloadProgress: 0 } : current);
    try {
      const result = await api.downloadUpdate();
      if (result.ok) {
        setUpdateDialog((current) => current ? { ...current, downloading: false, downloaded: true } : current);
        notify("更新包下载完成", "ok");
      } else {
        setUpdateDialog((current) => current ? { ...current, downloading: false, error: result.error || "下载失败" } : current);
      }
    } catch (error) {
      setUpdateDialog((current) => current ? { ...current, downloading: false, error: error.message || "下载失败" } : current);
    }
  }
  async function installUpdateNow() {
    try {
      const result = await api.installUpdate();
      if (!result.ok) notify(result.error || "安装启动失败", "error");
    } catch (error) {
      notify(error.message || "安装启动失败", "error");
    }
  }

  async function runNow() {
    if (busy || setupBusy) return;
    setBusy(true);
    try {
      const result = await api.runCheckin(false);
      notify(result.ok ? "签到任务已完成" : result.output?.includes("已有签到进程") ? "余额更新完成后，请再试一次签到" : "签到失败，请查看运行历史", result.ok ? "ok" : "error");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function toggleTask(enabled) {
    const previous = Boolean(status?.task?.installed);
    setStatus((current) => current ? {
      ...current,
      task: { ...current.task, installed: enabled },
      settings: { ...current.settings, taskEnabled: enabled },
    } : current);
    try {
      const task = await api.setTaskEnabled(enabled);
      setStatus((current) => current ? { ...current, task, settings: { ...current.settings, taskEnabled: task.installed } } : current);
      notify(enabled ? "自动签到已开启" : "自动签到已关闭");
    } catch (error) {
      setStatus((current) => current ? {
        ...current,
        task: { ...current.task, installed: previous },
        settings: { ...current.settings, taskEnabled: previous },
      } : current);
      notify(error?.message ? `自动任务修改失败：${error.message.replace(/^Error invoking remote method '[^']+':\s*/, "")}` : "自动任务修改失败，请稍后重试", "error");
    }
  }
  async function saveSettings(settings) {
    try {
      const result = await api.saveSettings(settings);
      setStatus((current) => current ? { ...current, settings: result.settings, task: result.task } : current);
      notify("设置已保存，自动任务时间已同步");
    } catch (error) {
      notify(error?.message ? `设置保存失败：${error.message.replace(/^Error invoking remote method '[^']+':\s*/, "")}` : "设置保存失败，请稍后重试", "error");
    }
  }
  async function setup() {
    if (setupBusy) return;
    setSetupBusy(true);
    setSetupPhase("正在打开 Chrome");
    notify("正在打开 Chrome，请完成 GitHub 登录与 2FA");
    try {
      const result = await api.startSetup();
      if (result.ok) {
        notify("GitHub 账号绑定完成");
        await refresh();
      } else {
        notify(result.error || "GitHub 绑定失败", "error");
      }
    } catch {
      notify("无法启动 GitHub 绑定流程，请重启应用后重试", "error");
    } finally {
      setSetupBusy(false);
      setSetupPhase(null);
    }
  }
  function openMigration(mode) {
    setMigration({ mode, password: "", confirmPassword: "", busy: false, error: null });
  }
  async function loadLogs() {
    setLogDialog((current) => ({ logs: current?.logs || [], loading: true, error: null }));
    try {
      const logs = await api.getLogs();
      setLogDialog({ logs, loading: false, error: null });
    } catch {
      setLogDialog((current) => ({ logs: current?.logs || [], loading: false, error: "日志读取失败，请稍后重试。" }));
    }
  }
  async function confirmMigration() {
    if (migration.password.length < 8) {
      setMigration({ ...migration, error: "迁移密码至少需要 8 个字符" });
      return;
    }
    if (migration.mode === "export" && migration.password !== migration.confirmPassword) {
      setMigration({ ...migration, error: "两次输入的密码不一致" });
      return;
    }
    setMigration({ ...migration, busy: true, error: null });
    let result;
    try {
      result = migration.mode === "export" ? await api.exportData(migration.password) : await api.importData(migration.password);
    } catch (error) {
      const backendOutdated = error?.message?.includes("No handler registered");
      setMigration((current) => ({
        ...current,
        busy: false,
        error: backendOutdated ? "应用后台仍是旧版本，请完全退出 AgentPunch 后重新启动" : "迁移操作失败，请稍后重试",
      }));
      return;
    }
    if (result.canceled) { setMigration(null); return; }
    if (!result.ok) {
      setMigration((current) => ({ ...current, busy: false, error: result.error || "迁移操作失败" }));
      return;
    }
    const mode = migration.mode;
    setMigration(null);
    notify(mode === "export" ? "迁移包已安全导出" : "账号与本地数据已导入");
    if (mode === "import") await refresh();
  }

  const title = useMemo(() => page === "home" ? "首页" : page === "history" ? "运行历史" : "设置", [page]);
  useEffect(() => { document.title = `AgentPunch · ${title}`; }, [title]);

  return <div className="app-shell"><Sidebar page={page} setPage={setPage} />
    <div className="workspace">
      {page === "home" && <HomePage status={status} balance={balance} balanceBusy={balanceBusy} busy={busy} setupBusy={setupBusy} setupPhase={setupPhase} onRun={runNow} onTaskToggle={toggleTask} onSetup={setup} />}
      {page === "history" && <HistoryPage runs={status?.runs} />}
      {page === "settings" && <SettingsPage status={status} setupBusy={setupBusy} setupPhase={setupPhase} onSave={saveSettings} onSetup={setup} onOpenData={() => api.openDataFolder()} onMigration={openMigration} onOpenLogs={loadLogs} onCheckUpdate={checkUpdate} onRun={runNow} busy={busy} />}
    </div>
    <MigrationDialog value={migration} onChange={setMigration} onClose={() => setMigration(null)} onConfirm={confirmMigration} />
    <UpdateDialog value={updateDialog} onClose={() => setUpdateDialog(null)} onDownload={downloadUpdate} onInstall={installUpdateNow} />
    <LogDialog value={logDialog} onClose={() => setLogDialog(null)} onRefresh={loadLogs} />
    {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "error" ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}<span>{toast.message}</span></div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
