@ECHO off
rem Windows twin of ./claude — see that file for why this exists.
rem
rem Deliberately shaped like the shim npm writes, quoted %dp0% reference and
rem all: planLaunch (packages/core/src/exec.ts) reads a .cmd to find the
rem `node <entry point>` it wraps and spawns that directly. A .cmd it *cannot*
rem read has to go through cmd.exe instead, and cmd.exe cannot carry the
rem multi-line --append-system-prompt every interactive step sends (see
rem exec.ts's header) — so an opaque stub here would fail the smoke test for a
rem reason no real install has.
SETLOCAL
CALL :find_dp0
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%\claude-stub.js" %*
:find_dp0
SET dp0=%~dp0
EXIT /b
