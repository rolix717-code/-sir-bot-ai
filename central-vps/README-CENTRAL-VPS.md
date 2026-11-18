# SIR BOT AI — Central VPS starter (0.1)

This folder adds a **starter credential vault service** for the planned centralized Windows VPS. It is not a finished MT5 multi-customer execution platform.

## What is included
- FastAPI vault service with AES-256-GCM encryption at rest.
- Random 96-bit nonce per stored password and account-specific authenticated data.
- Worker-token-protected internal credential retrieval and deletion routes.
- Passwords are never logged, and there is no admin password-reveal endpoint.
- PowerShell helper to generate a 32-byte vault key and worker token.
- Execution remains disabled; this service does not place orders or start MT5 terminals.

## Critical integration work still required
1. Add authenticated customer-session middleware to `POST /accounts`; verify the owner ID from the session, never trust a client-supplied owner ID.
2. Add CSRF protection, rate limits, TLS/reverse proxy, request-size limits, audit logging, backup encryption, key rotation and a recovery procedure.
3. Keep `SIRBOT_VAULT_KEY` outside the database and source tree. Restrict Windows service account access. Losing the key makes stored passwords unrecoverable.
4. Build the Windows MT5 worker: provision one isolated terminal data directory per account, connect, verify broker/server/login, publish balance/equity/margin/positions, heartbeat, reconnect and shut down safely.
5. Integrate website Connect Account form with this service through authenticated Cloudflare Worker routes. Do not call this service directly from browser JavaScript.
6. Add customer ownership-checked disconnect/delete and explicit demo/live consent records.
7. Implement queue leases, idempotency, per-account risk limits, max daily loss, max drawdown, spread/slippage checks and emergency stop before any order execution.
8. Test with demo accounts only. Live execution must remain disabled until independent security and broker execution testing is complete.

## Local Windows VPS setup (after provisioning)
1. Copy this folder to the VPS.
2. Run `./generate-secrets.ps1` in PowerShell and store both values as machine-level environment variables using a protected admin session. Do not paste them into chat or GitHub.
3. Run `./start-vault.ps1`.
4. Confirm `http://127.0.0.1:8787/health` reports `execution: DISABLED`.
5. Keep port 8787 private; expose it only through a properly configured HTTPS reverse proxy after authentication is implemented.

## API status
- `GET /health`: service health only.
- `POST /accounts`: encrypted storage prototype; **not safe to expose publicly until customer authentication is added**.
- `GET /worker/accounts/{id}`: internal worker retrieval protected by `SIRBOT_WORKER_TOKEN`.
- `DELETE /accounts/{id}`: worker-token protected prototype; customer ownership deletion flow remains to be implemented.

## Important
This build does not yet deliver the promised one-click customer experience. It is a new backend foundation to integrate next. Existing website and Cloudflare Worker behavior are retained. No deployment, VPS provisioning, MT5 multi-terminal test, or live-broker test has been performed.
