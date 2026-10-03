@ECHO off
rem Windows twin of ./claude, shaped like an npm shim for the same reason as
rem scripts/package/fixtures/bin/claude.cmd: planLaunch reads it and spawns
rem the `node <entry>` it wraps directly.
SETLOCAL
CALL :find_dp0
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%\claude-flood.js" %*
:find_dp0
SET dp0=%~dp0
EXIT /b
