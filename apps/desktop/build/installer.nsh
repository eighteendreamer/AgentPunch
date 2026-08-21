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

Var IsSilentUpdate

!macro customUnInstall
  ClearErrors
  ${GetParameters} $R0

  ; 检测是否为静默更新场景：
  ; 1) 安装程序传了 --updated 参数（从 updater.mjs 调用）
  ; 2) 存在更新标记文件（覆盖安装时安装阶段写入）
  StrCpy $IsSilentUpdate "0"
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $IsSilentUpdate "1"
  ${EndIf}
  ; 检查标记文件
  ${If} ${FileExists} "$LOCALAPPDATA\AgentRouterCheckin\.updating"
    StrCpy $IsSilentUpdate "1"
  ${EndIf}

  ${If} $IsSilentUpdate == "1"
    DetailPrint "检测到更新场景，跳过本地数据清理。"
  ${Else}
    DetailPrint "正在结束 AgentPunch 后台进程..."
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "AgentPunch.exe"'
    Sleep 800

    DetailPrint "正在停止 AgentPunch 自动执行任务..."
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /End /TN "AgentRouterDailyCheckin"'
    Sleep 800
    DetailPrint "正在删除 AgentPunch 自动执行任务..."
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "AgentRouterDailyCheckin" /F'

    !insertmacro AgentPunchRemoveDirectory "$LOCALAPPDATA\agentpunch-desktop-updater" "AgentPunch 安装器缓存"

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 AgentPunch 本地账号与历史数据？$\r$\n$\r$\n选择'是'将永久删除 GitHub 登录状态、签到历史、余额、设置、日志和本地备份。$\r$\n$\r$\n数据目录：$LOCALAPPDATA\AgentRouterCheckin$\r$\n$\r$\n如需迁移，请先选择'否'，重新打开软件并导出迁移包。" IDNO AgentPunchKeepLocalData
      !insertmacro AgentPunchRemoveDirectory "$LOCALAPPDATA\AgentRouterCheckin" "AgentPunch 本地数据"
    AgentPunchKeepLocalData:
  ${EndIf}

  ; 清理更新标记文件
  Delete "$LOCALAPPDATA\AgentRouterCheckin\.updating"
!macroend
!endif

!ifndef BUILD_UNINSTALLER
; 安装阶段：如果是静默安装（带 /S 参数），写入更新标记文件
!macro customInstall
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    ; 静默安装 = 更新场景，写入标记文件供卸载阶段检测
    CreateDirectory "$LOCALAPPDATA\AgentRouterCheckin"
    FileOpen $0 "$LOCALAPPDATA\AgentRouterCheckin\.updating" w
    FileWrite $0 "updating"
    FileClose $0
    DetailPrint "已写入更新标记文件，将保留本地数据。"
  ${EndIf}
!macroend
!endif
