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


; Request write access without writing, truncating, or deleting the existing file.
; Run every probe before creating directories or extracting any payload.
!macro DefineFileGuards PREFIX ACTION
Function ${PREFIX}RequireWritableFile
  IfFileExists "$CheckedPath" 0 writable
  System::Call 'kernel32::CreateFileW(w "$CheckedPath", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .r0'
  IntCmp $0 -1 blocked
  System::Call 'kernel32::CloseHandle(p r0)'
  Return
blocked:
  SetErrorLevel 32
  IfSilent +2
  MessageBox MB_ICONSTOP|MB_OK "${ACTION}尚未开始。请先关闭 ChisaCloudCode 及占用下列文件的程序，然后重新${ACTION}：$\r$\n$CheckedPath"
  Quit
writable:
FunctionEnd

!macroend

!insertmacro DefineFileGuards "" "安装"
!insertmacro DefineFileGuards "un." "卸载"

Function .onInstFailed
  SetErrorLevel 1
FunctionEnd

Section
  ; Refuse an open application before modifying installed payload.
  StrCpy $CheckedPath "$INSTDIR\${PRODUCT_NAME}.exe"
  Call RequireWritableFile

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
  StrCpy $CheckedPath "$INSTDIR\${PRODUCT_NAME}.exe"
  Call un.RequireWritableFile

  !include "${UNINSTALL_PREFLIGHT_INCLUDE}"
  ClearErrors
  !include "${UNINSTALL_INCLUDE}"
  ; Keep the registered retry entry until all installed payload files are gone.
  ClearErrors
  IfFileExists "$SMPROGRAMS\${PRODUCT_NAME}.lnk" 0 +3
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  IfErrors uninstall_failed
  IfFileExists "$DESKTOP\${PRODUCT_NAME}.lnk" 0 +3
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  IfErrors uninstall_failed
  ; The supported _?= entry runs in place; its own image remains for its caller
  ; to remove after exit. A normal copied uninstaller can remove the original.
  StrCmp "$EXEPATH" "$INSTDIR\Uninstall.exe" uninstall_payload_removed
  Delete "$INSTDIR\Uninstall.exe"
  IfErrors uninstall_failed
uninstall_payload_removed:
  RMDir "$INSTDIR"
  ClearErrors
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  IfErrors uninstall_failed
  SetErrorLevel 0
  Goto uninstalled
uninstall_failed:
  SetErrorLevel 1
  IfSilent +2
  MessageBox MB_ICONSTOP|MB_OK "卸载未完成。请关闭占用安装文件的程序并检查目录权限，然后从原卸载入口重试。项目文件和同步记录均未删除。"
  Quit
uninstalled:
SectionEnd
