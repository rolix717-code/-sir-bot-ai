# SIR BOT AI — Central VPS preparation package

This package is based on the latest project ZIP supplied for this integration. It preserves the existing GitHub Pages frontend, Cloudflare Worker backend, authentication, and demo-locked MT5 bridge behavior.

## Upload to GitHub
1. Extract this ZIP on your PC.
2. Open the existing repository and choose **Add file → Upload files**.
3. Upload the contents of the extracted project folder into the repository root (not the containing folder itself).
4. If GitHub asks whether to replace existing files, review the changed-file list. The intended changes are additions under `central-vps/` and this guide. Do not delete unrelated files.
5. Commit to a new branch first if possible; otherwise download a backup of the current repository before committing.

## What is included now
- Existing website/backend source, retained as the baseline.
- Central Windows VPS credential-vault prototype under `central-vps/`.
- AES-256-GCM encryption-at-rest foundation with a key kept outside source control.
- PowerShell helpers to generate secrets and start the local vault service.
- Detailed integration and safety checklist in `central-vps/README-CENTRAL-VPS.md`.

## What is NOT enabled yet
This is a preparation/integration package, not the finished one-click MT5 service. The website is not yet wired to the vault. The vault's account-create route is explicitly a prototype and must not be exposed publicly until customer authentication/ownership checks, CSRF protection, rate limits, TLS, audit logging and key management are implemented. No MT5 terminal provisioning, live balance streaming, multi-account execution worker, or order execution is included. Trading remains OFF/demo-only.

## After VPS purchase
We will configure Windows Server, install Python dependencies, generate secrets directly on the VPS, keep the vault bound to localhost/private networking, then implement authenticated Cloudflare-to-VPS account onboarding and an isolated MT5 worker. Do not put passwords, vault keys, worker tokens, or broker credentials in GitHub or this chat.

## Safety
Use demo accounts first. A successful website connection or vault health check does not prove an MT5 account is connected and does not authorize trading. Never enable live trading until demo tests, risk limits, emergency-stop behavior, and security review pass.
