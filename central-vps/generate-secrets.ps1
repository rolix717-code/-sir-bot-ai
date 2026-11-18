# Run in PowerShell on the Windows VPS. Save the output privately.
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$key = [Convert]::ToBase64String($bytes)
$tokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$token = [Convert]::ToBase64String($tokenBytes)
Write-Host "SIRBOT_VAULT_KEY=$key"
Write-Host "SIRBOT_WORKER_TOKEN=$token"
Write-Host 'Store these as machine environment secrets. Never commit or send them in chat.'
