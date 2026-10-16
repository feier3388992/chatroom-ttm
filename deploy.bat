@echo off
setlocal enabledelayedexpansion

rem ---- 请按需修改以下部署参数（示例值，勿提交真实凭据）----
set SSH=C:\Windows\System32\OpenSSH\ssh.exe
set SSHPASS=C:\Windows\System32\OpenSSH\sshpass.exe
set SCP=C:\Windows\System32\OpenSSH\scp.exe
set SERVER=user@your-server
set PASS=your-password
set PORT=22
set REMOTE_DIR=/home/user/quicktalk
set APP_PORT=18675
set TAR=quicktalk_deploy.tar.gz
set TMP_EXCLUDE=%TEMP%\tar_exclude.txt

echo database/ > "%TMP_EXCLUDE%"
echo uploads/ >> "%TMP_EXCLUDE%"
echo __pycache__/ >> "%TMP_EXCLUDE%"

echo === Creating archive (excluding database/uploads) ===
tar -czf %TAR% --exclude-from="%TMP_EXCLUDE%" main.py utils/ pages/ static/

echo === Copying package to server ===
%SSHPASS% -p %PASS% %SCP% -P %PORT% %TAR% %SERVER%:/tmp/
if %errorlevel% neq 0 (
    echo [FAIL] scp failed
    pause
    exit /b 1
)

echo === Deploying on server ===
%SSHPASS% -p %PASS% %SSH% -p %PORT% %SERVER% "mkdir -p %REMOTE_DIR%/database %REMOTE_DIR%/uploads && cd %REMOTE_DIR% && tar -xzf /tmp/%TAR%" < nul

echo === Restarting QuickTalk server (port %APP_PORT%) ===
%SSHPASS% -p %PASS% %SSH% -p %PORT% %SERVER% "kill $(fuser %APP_PORT%/tcp 2>/dev/null) 2>/dev/null; sleep 1; cd %REMOTE_DIR% && nohup python3 -m uvicorn main:app --host 0.0.0.0 --port %APP_PORT% > /tmp/quicktalk.log 2>&1 &" < nul

echo === Done ===
echo Waiting 3s...
%SSHPASS% -p %PASS% %SSH% -p %PORT% %SERVER% "sleep 3 && curl -s -o /dev/null -w 'HTTP Status: %%{http_code}\n' http://localhost:%APP_PORT%/" < nul

pause
