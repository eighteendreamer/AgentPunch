const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentPunch", {
  getStatus: () => ipcRenderer.invoke("agent:get-status"),
  getTaskStatus: () => ipcRenderer.invoke("agent:get-task-status"),
  getLogs: () => ipcRenderer.invoke("agent:get-logs"),
  refreshBalance: () => ipcRenderer.invoke("agent:refresh-balance"),
  runCheckin: (force = false) => ipcRenderer.invoke("agent:run-checkin", { force }),
  setTaskEnabled: (enabled) => ipcRenderer.invoke("agent:set-task-enabled", { enabled }),
  saveSettings: (settings) => ipcRenderer.invoke("agent:save-settings", settings),
  startSetup: () => ipcRenderer.invoke("agent:start-setup"),
  onSetupProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:setup-progress", listener);
    return () => ipcRenderer.removeListener("agent:setup-progress", listener);
  },
  openDataFolder: () => ipcRenderer.invoke("agent:open-data-folder"),
  exportData: (password) => ipcRenderer.invoke("agent:export-data", { password }),
  importData: (password) => ipcRenderer.invoke("agent:import-data", { password }),
});
