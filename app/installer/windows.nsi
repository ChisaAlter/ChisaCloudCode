Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
Name "${PRODUCT_NAME}"
OutFile "${INSTALLER_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "InstallLocation"
RequestExecutionLevel user
BrandingText " "
!define MUI_ICON "${INSTALLER_ICON}"
!define MUI_UNICON "${INSTALLER_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_NAME}.exe"
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!include "MUI2.nsh"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}"

Var CheckedPath
Var PreviousMutagenDirectory

; Request write access without writing, truncating, or deleting the existing file.
; Run every probe before creating directories or extracting any payload.
Function RequireWritableFile
  IfFileExists "$CheckedPath" 0 writable
  System::Call 'kernel32::CreateFileW(w "$CheckedPath", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .r0'
  IntCmp $0 -1 blocked
  System::Call 'kernel32::CloseHandle(p r0)'
  Return
blocked:
  SetErrorLevel 32
  IfSilent +2
  MessageBox MB_ICONSTOP|MB_OK "安装尚未开始。请先关闭 ChisaCloudCode 及占用下列文件的程序，然后重新安装：$\r$\n$CheckedPath"
  Quit
writable:
FunctionEnd

; Closing the app leaves its Mutagen daemon resident. Stop only this app's
; dedicated daemon, only when the installed engine is actually in use.
Function StopResidentSync
  IfFileExists "$INSTDIR\mutagen.exe" 0 stopped
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\mutagen.exe", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .r0'
  IntCmp $0 -1 stop_daemon
  System::Call 'kernel32::CloseHandle(p r0)'
  Return
stop_daemon:
  ReadEnvStr $PreviousMutagenDirectory "MUTAGEN_DATA_DIRECTORY"
  System::Call 'kernel32::SetEnvironmentVariableW(w "MUTAGEN_DATA_DIRECTORY", w "$APPDATA\ChisaCloudCode\mutagen")'
  nsExec::ExecToStack /TIMEOUT=15000 '"$INSTDIR\mutagen.exe" daemon stop'
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "MUTAGEN_DATA_DIRECTORY", w "$PreviousMutagenDirectory")'
  StrCmp $0 "0" wait_for_exit sync_stop_failed
wait_for_exit:
  ; The daemon may acknowledge termination before Windows releases its image.
  StrCpy $2 50
check_exit:
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\mutagen.exe", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .r0'
  IntCmp $0 -1 still_running
  System::Call 'kernel32::CloseHandle(p r0)'
  Return
still_running:
  IntOp $2 $2 - 1
  IntCmp $2 0 sync_stop_failed
  Sleep 100
  Goto check_exit
sync_stop_failed:
  SetErrorLevel 32
  IfSilent +2
  MessageBox MB_ICONSTOP|MB_OK "安装尚未开始。后台文件同步尚未退出，请稍后重新安装；若仍失败，请联系维护者。项目文件和同步记录均未删除。"
  Quit
stopped:
FunctionEnd

Function .onInstFailed
  SetErrorLevel 1
FunctionEnd

Section
  ; Refuse an open application before stopping any background work.
  StrCpy $CheckedPath "$INSTDIR\${PRODUCT_NAME}.exe"
  Call RequireWritableFile
  Call StopResidentSync
  !include "${PREFLIGHT_INCLUDE}"
  StrCpy $CheckedPath "$INSTDIR\Uninstall.exe"
  Call RequireWritableFile
  ClearErrors
  SetOverwrite on
  !include "${PAYLOAD_INCLUDE}"
  SetOutPath "$INSTDIR"
  IfErrors install_failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors install_failed
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  IfErrors install_failed
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_NAME}.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  IfErrors install_failed
  SetErrorLevel 0
  Goto installed
install_failed:
  SetErrorLevel 1
  IfSilent +2
  MessageBox MB_ICONSTOP|MB_OK "安装未完成。请检查文件占用和安装目录权限，关闭相关程序后重新安装。"
  Quit
installed:
SectionEnd

Function CreateDesktopShortcut
  SetOutPath "$INSTDIR"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
