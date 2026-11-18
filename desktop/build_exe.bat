@echo off
REM Builds dist\Generic-Performance.exe (single file, no console window).
cd /d "%~dp0"
if not exist .venv python -m venv .venv
.venv\Scripts\python -m pip install -q -r requirements.txt pyinstaller
.venv\Scripts\pyinstaller --noconfirm --onefile --windowed --name Generic-Performance generic_performance.py
echo.
echo Done: dist\Generic-Performance.exe
pause
