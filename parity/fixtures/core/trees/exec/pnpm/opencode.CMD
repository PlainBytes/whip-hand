@SETLOCAL
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\lib\opencode.mjs" %*
) ELSE (
  node  "%~dp0\..\lib\opencode.mjs" %*
)
