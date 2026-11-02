@echo off
setlocal
cd /d "%~dp0.." || exit /b 1

echo [1/6] Checking package and lockfile metadata...
node scripts\check-release.mjs
if errorlevel 1 goto :failed

echo [2/6] Installing locked dependencies with npm 11.6.2...
call npx --yes npm@11.6.2 ci
if errorlevel 1 goto :failed

echo [3/6] Building...
call npm run build
if errorlevel 1 goto :failed

echo [4/6] Running tests...
call npm test
if errorlevel 1 goto :failed

echo [5/6] Running smoke conversions...
call npm run smoke
if errorlevel 1 goto :failed

echo [6/6] Checking npm availability and packing...
node scripts\check-release.mjs --check-registry
if errorlevel 1 goto :failed
call npm pack
if errorlevel 1 goto :failed

echo Ready for review. No commits, tags, pushes or publishes were performed.
exit /b 0

:failed
echo Preparation failed. Fix the error above before retrying. No publish was attempted.
exit /b 1
