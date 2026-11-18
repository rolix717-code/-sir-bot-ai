# SIR BOT AI — Safe VPS Preparation Build

## What changed in this package
- MT5 execution is OFF by default for newly paired bridges.
- Existing bridge records are also forced to execution OFF and DEMO-only when the Worker initializes its bridge tables.
- The Windows bridge has a second local execution gate: `SIRBOT_EXECUTION_ENABLED` must explicitly be `true`; demo-only is enabled by default.
- Added an admin-only `/admin/mt5/accounts` endpoint and dashboard table for registered bridge metadata and last heartbeat.
- Added a customer safety notice explaining that this build does not collect or store broker passwords.
- The bridge start example explicitly sets execution OFF and DEMO-only.

## Important limitations — not a centralized VPS release yet
This source still uses a customer-side/local MT5 bridge and one logged-in MT5 terminal per bridge process. It does NOT yet implement:
- central VPS credential onboarding or encrypted MT5 password storage;
- per-customer terminal provisioning and isolation on a central Windows VPS;
- MT5 account balance/equity/open-position telemetry to the admin dashboard;
- centralized credential decryption/rotation and customer consent records.

Do not ask customers to submit broker passwords until the centralized credential vault, encryption-key management, access controls, audit trail, and VPS worker retrieval flow have been implemented and tested. This package intentionally tells customers not to submit those passwords. It therefore does not claim their MT5 passwords are encrypted.

## Deployment checks
1. Back up the current Cloudflare Worker and D1 database.
2. Review `backend/src/index.js` and deploy the Worker with your existing Wrangler configuration.
3. Test `/health`, login, `/admin/users`, and `/admin/mt5/accounts` using an admin session.
4. Pair a DEMO MT5 terminal only. Keep `SIRBOT_EXECUTION_ENABLED=false`.
5. Confirm the admin page lists the bridge and last heartbeat.
6. Do not enable live trading from this build.

## Security
- Never commit `bridge-start.ps1` containing a real token.
- Keep bridge tokens and Cloudflare secrets private.
- Rotate any token that has been exposed.
- This package has not been deployed to your Cloudflare account and has not been tested against a live broker.
