; Tauri's NSIS hooks (bundle.windows.nsis.installerHooks). The installer puts
; the `whiphand` CLI sidecar (scripts/package/sidecar.mjs) beside the app, and
; these put that folder on the user's PATH, so `whiphand` and `whiphand tui`
; work from a new terminal; uninstalling takes the entry off again.
;
; The edit runs in PowerShell rather than in NSIS strings: an NSIS string is
; NSIS_MAX_STRLEN (1024) characters, and a longer PATH read into one would be
; written back cut short. The registry value is read unexpanded, so entries
; like %USERPROFILE%\bin stay as they are. The folder reaches PowerShell
; through an environment variable, never inside the command line, so no
; character in it needs quoting.

!include "WinMessages.nsh"

!define WHIPHAND_PS `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
!define WHIPHAND_PS_READ `$$k = 'HKCU:\Environment'; $$p = (Get-Item -LiteralPath $$k).GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$e = @($$p -split ';' | Where-Object { $$_ -ne '' }); $$d = $$env:WHIPHAND_DIR;`

!macro WHIPHAND_SET_PATH SCRIPT
  System::Call 'Kernel32::SetEnvironmentVariable(t "WHIPHAND_DIR", t "$INSTDIR")i'
  nsExec::ExecToLog `${WHIPHAND_PS} "${WHIPHAND_PS_READ} ${SCRIPT}"`
  Pop $0
  StrCmp $0 "0" +2
    DetailPrint "Could not update PATH for $INSTDIR (exit $0)"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; Up to 0.5 the app itself was whiphand.exe, and Tauri's installer deletes the
; previous main binary by the name it recorded, after copying the new files in:
; that would delete the CLI sidecar, which is whiphand.exe now. Forgetting the
; old name keeps it, and the sidecar's copy writes over the old app instead.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "MainBinaryName"
  StrCmp $0 "whiphand.exe" 0 +2
    DeleteRegValue SHCTX "${UNINSTKEY}" "MainBinaryName"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro WHIPHAND_SET_PATH `if ($$e -notcontains $$d) { Set-ItemProperty -LiteralPath $$k -Name Path -Type ExpandString -Value (($$e + $$d) -join ';') }`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro WHIPHAND_SET_PATH `$$n = @($$e | Where-Object { $$_ -ne $$d }); if ($$n.Count -ne $$e.Count) { Set-ItemProperty -LiteralPath $$k -Name Path -Type ExpandString -Value ($$n -join ';') }`
!macroend
