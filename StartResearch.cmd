@echo off
cd /d "%~dp0"
node scripts\start-research.cjs %*
if errorlevel 1 pause
