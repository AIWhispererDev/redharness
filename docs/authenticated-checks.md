# Authenticated Pocket Socrates checks

The harness supports authenticated checks without storing passwords or invite codes in the repo.

## Current command

```bash
npx tsx src/cli.ts auth-smoke pocket-socrates
```

Without a storage state file, this safely skips:

```text
Status: skipped
Authenticated smoke skipped
```

## If Google says "This browser or app may not be secure"

Google can block browsers launched directly by Playwright, even if the executable is Brave. Use this workaround instead:

1. Close all Brave windows.
2. Launch Brave yourself with remote debugging enabled.
3. Log in normally.
4. Let the harness connect to that already-open Brave session and save the Pocket Socrates cookies.

PowerShell:

```powershell
& "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\qa-harness\.auth\pocket-socrates-manual-brave" "https://pocketsoc.me/en/dashboard"
```

In that Brave window:

1. Click Google.
2. Complete Gmail login.
3. Wait until you reach the real Pocket Socrates dashboard.
4. Leave Brave open.

In a second PowerShell terminal:

```powershell
cd C:\path\to\qa-harness
npm run save-auth-cdp -- --endpoint "http://127.0.0.1:9222" --save-storage ".auth\pocket-socrates.json"
```

Then run:

```powershell
npx tsx src/cli.ts auth-smoke pocket-socrates --storage-state ".auth\pocket-socrates.json" --output-dir "artifacts\pocket-socrates\auth-smoke"
```

## Older helper: Playwright-launched Brave

This can still be blocked by Google, but is kept for non-Google login paths:

```powershell
npm run save-auth -- --executable-path "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --user-data-dir ".auth\pocket-socrates-brave-profile" --save-storage ".auth\pocket-socrates.json" --url "https://pocketsoc.me/en/dashboard"
```

## What auth-smoke checks now

- `/dashboard` does not redirect to `/sign-in`.
- Dashboard renders non-empty content.
- Dashboard nav labels are present: `POCKET SOC`, `THE CRUCIBLE`, `SOLO`, `PEER`, `JOURNEY`, `DOCUMENT`.
- Sign-in UI is not visible after authenticated load.
- Medical disclaimer modal is detected if present.
- Console errors are captured to `console.json` and fail the check if present.
- Network failures are captured to `network-failures.json`; benign `net::ERR_ABORTED` requests are recorded but ignored.
- HTTP 5xx responses are captured to `network-4xx-5xx.json` and fail the check if present.
- Screenshot saved to the output dir.

## Security note

Do not commit `.auth/pocket-socrates.json` or any `.auth/*profile` directory. They may contain session cookies.
