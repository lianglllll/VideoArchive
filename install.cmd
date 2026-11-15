@echo off
rem One-click install / uninstall for VideoArchive (a DSH plugin).
rem It finds Node itself: PATH first, then the Node bundled with DSH.
rem   install.cmd            install into DSH
rem   install.cmd --remove   remove from DSH
rem   install.cmd --profile <name>
setlocal
set "PLUGIN=%~dp0"
set "NODE="

for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"

if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes" (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if not defined NODE if exist "%%~D\dependencies\node\bin\node.exe" set "NODE=%%~D\dependencies\node\bin\node.exe"
  )
)

if not defined NODE (
  echo.
  echo   [x] Node.js not found. Install it first:
  echo       winget install OpenJS.NodeJS.LTS
  echo.
  exit /b 1
)

"%NODE%" "%PLUGIN%install.mjs" %*
exit /b %ERRORLEVEL%
