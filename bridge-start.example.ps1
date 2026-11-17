# Copy this file to bridge-start.ps1 and paste your own one-time token locally.
$env:SIRBOT_API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev"
$env:SIRBOT_BRIDGE_TOKEN = "PASTE_YOUR_PRIVATE_TOKEN_HERE"
$env:SIRBOT_EXECUTION_ENABLED = "false"
py .\bridge.py
