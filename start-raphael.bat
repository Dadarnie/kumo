@echo off
rem Double-click to start Raphael (LM Studio's server must be on).
cd /d "%~dp0"
".venv\Scripts\python.exe" chat.py --ui
pause
