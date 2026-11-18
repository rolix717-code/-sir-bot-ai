$ErrorActionPreference = 'Stop'
if (-not $env:SIRBOT_VAULT_KEY -or -not $env:SIRBOT_WORKER_TOKEN) { throw 'Set SIRBOT_VAULT_KEY and SIRBOT_WORKER_TOKEN first.' }
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\uvicorn.exe vault_service:app --host 127.0.0.1 --port 8787
