!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifdef BUILD_UNINSTALLER
!macro AgentPunchRemoveDirectory DIRECTORY_PATH DISPLAY_NAME
  DetailPrint "正在删除 ${DISPLAY_NAME}..."
  SetFileAttributes "${DIRECTORY_PATH}\*.*" NORMAL
  RMDir /r "${DIRECTORY_PATH}"
  Sleep 500
  ${If} ${FileExists} "${DIRECTORY_PATH}"
    DetailPrint "${DISPLAY_NAME} 仍被占用，正在重试..."
    RMDir /r "${DIRECTORY_PATH}"
    Sleep 1000
  ${EndIf}
  ${If} ${FileExists} "${DIRECTORY_PATH}"
    DetailPrint "${DISPLAY_NAME} 将在 Windows 下次启动时继续删除。"
    RMDir /r /REBOOTOK "${DIRECTORY_PATH}"
    SetRebootFlag true
    MessageBox MB_OK|MB_ICONEXCLAMATION "${DISPLAY_NAME} 中仍有文件被占用，Windows 已安排在下次重启时完成删除。残留目录：${DIRECTORY_PATH}"
  ${Else}
    DetailPrint "${DISPLAY_NAME} 已删除。"
  ${EndIf}
!macroend

!macro customUnInstall
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    DetailPrint "正在结束 AgentPunch 后台进程..."
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "AgentPunch.exe"'
    Sleep 800

    DetailPrint "正在停止 AgentPunch 自动执行任务..."
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /End /TN "AgentRouterDailyCheckin"'
    Sleep 800
    DetailPrint "正在删除 AgentPunch 自动执行任务..."
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "AgentRouterDailyCheckin" /F'

    !insertmacro AgentPunchRemoveDirectory "$LOCALAPPDATA\agentpunch-desktop-updater" "AgentPunch 安装器缓存"

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 AgentPunch 本地账号与历史数据？$\r$\n$\r$\n选择‘是’将永久删除 GitHub 登录状态、签到历史、余额、设置、日志和本地备份。$\r$\n$\r$\n数据目录：$LOCALAPPDATA\AgentRouterCheckin$\r$\n$\r$\n如需迁移，请先选择‘否’，重新打开软件并导出迁移包。" IDNO AgentPunchKeepLocalData
      !insertmacro AgentPunchRemoveDirectory "$LOCALAPPDATA\AgentRouterCheckin" "AgentPunch 本地数据"
    AgentPunchKeepLocalData:
  ${EndIf}
!macroend
!endif
