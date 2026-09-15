@echo off
cd /d "%~dp0"
set "PY_CMD="

if not "%PYTHON_EXE%"=="" (
  set "PY_CMD=%PYTHON_EXE%"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 set "PY_CMD=python"
)

if "%PY_CMD%"=="" (
  where py >nul 2>nul
  if %errorlevel%==0 set "PY_CMD=py"
)

if "%PY_CMD%"=="" (
  echo Python was not found. Install Python 3.11+ and try again.
  pause
  exit /b 1
)

%PY_CMD% -c "import sys; print(sys.executable)" >nul 2>nul
if errorlevel 1 (
  echo Python was found but could not start. Repair your Python install or set PYTHON_EXE to python.exe.
  pause
  exit /b 1
)

%PY_CMD% simple_server.py
