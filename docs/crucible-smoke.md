# Crucible smoke checks

Run with a saved authenticated state:

```powershell
npx tsx src/cli.ts crucible-smoke pocket-socrates --storage-state ".auth\pocket-socrates.json" --output-dir "artifacts\pocket-socrates\crucible-smoke"
```

## Current behavior

- Opens `/en/dashboard` with saved auth state.
- Accepts the medical disclaimer if visible.
- Verifies the Crucible surface is visible.
- If no active input is visible, clicks `Start new session`.
- If a Pro paywall is visible, treats the paywall as the expected result for a non-Pro account and does not try to send a Soc prompt.
- If solo input is available without a Pro paywall, submits a harmless QA smoke prompt, waits for Soc response, saves the response, and scans it using the Pocket Socrates style rules.
- Captures screenshot, console logs, network failures, HTTP 4xx/5xx responses, Soc response text, and style findings.

## Artifacts

```text
artifacts/pocket-socrates/crucible-smoke/
  crucible.png
  soc-response.txt
  style-findings.json
  console.json
  network-failures.json
  network-4xx-5xx.json
```
