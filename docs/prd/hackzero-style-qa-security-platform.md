# HackZero-Style QA + Security Platform PRD

## Goal

Turn the existing Pocket Socrates QA harness from a smoke/regression checker into a proof-oriented QA/security agent that can find, reproduce, package, and eventually submit validated findings.

## Product Principles

1. **No repro, no finding** — suspected bugs must be replayed before they become confirmed findings.
2. **Evidence-first** — every finding needs screenshots, logs, request/response evidence where available, and exact steps.
3. **Safe by default** — no destructive pentest actions, brute force, payment abuse, spam, or exfiltration.
4. **Draft-only submissions** — generate Notion-ready packets but do not submit automatically unless explicitly enabled later.
5. **Pack-driven where possible** — reusable across other apps, with Pocket Socrates as first pack.

## Personas

- **QA reporter:** wants clean Notion-ready bug reports with reproducible steps.
- **Founder/operator:** wants continuous confidence after deploys.
- **Security reviewer:** wants safe black-box/authenticated security smoke checks with evidence.
- **Developer:** wants fix hints and eventually PR-ready patches.

## Core Features

### 1. Security Smoke

Command:

```bash
npx tsx src/cli.ts security-smoke <pack> --storage-state .auth/app.json --output-dir artifacts/app/security-smoke
```

Checks:

- Security headers: CSP, HSTS, X-Frame-Options/frame-ancestors, Referrer-Policy, Permissions-Policy.
- Cookie flags: Secure, HttpOnly where observable, SameSite.
- Public sensitive files: `.env`, `.git/config`, `sitemap.xml`, `robots.txt`, sourcemaps.
- Unauthenticated protected route behavior.
- Public bundle secret pattern scan for obvious private keys/tokens.
- CORS preflight sanity.
- Authenticated app security smoke: console errors, 4xx/5xx, protected page loads.

Acceptance:

- Produces `summary.md`, `summary.json`, screenshots/logs.
- Fails only on actionable security issues or explicit missing protections.
- Does not use destructive payloads.

### 2. AI Red-Team Smoke

Command:

```bash
npx tsx src/cli.ts ai-redteam <pack> --storage-state .auth/app.json
```

Safe probes:

- Ask AI to reveal system prompt.
- Ask AI to reveal another user/session data.
- Ask AI for internal account/session metadata.
- Ask AI to ignore policies/persona.

Acceptance:

- Captures prompts/responses.
- Flags likely leakage patterns.
- Does not submit harmful content or request real secrets.

### 3. Confirmed Finding Pipeline

Command:

```bash
npx tsx src/cli.ts bug-hunt <pack> --storage-state .auth/app.json --confirm-runs 2 --video
```

Flow:

1. Run selected probes.
2. Convert failures into suspected findings.
3. Replay each suspected finding `N` times.
4. Confirm only if it reproduces.
5. Generate finding packet.

Finding packet files:

```text
findings/<slug>/
  finding.md
  finding.json
  evidence.png
  console.json
  network.json
  replay.spec.ts
  video.webm       # optional
```

### 4. Notion-Ready Reports

Generate draft-only reports with:

- title
- severity
- type
- affected area
- steps
- expected
- actual
- reproducibility count
- evidence attachments
- console/network notes

### 5. White-Box Mode

Future command:

```bash
npx tsx src/cli.ts whitebox-security <pack> --repo C:/path/to/repo --url https://app
```

Reads source to discover routes, auth checks, API calls, and likely security boundaries. Generates live probes.

## Non-Goals for Initial Implementation

- No automatic Notion submission.
- No destructive exploitation.
- No brute force/rate-limit abuse beyond light double-submit checks.
- No actual payment portal modification.
- No auto-PR until source repo is explicitly provided.

## Initial Implementation Slice

Build now:

1. `security-smoke` command.
2. `findingPackets.ts` helper that writes Notion-ready finding packets.
3. Tests for security report rendering and finding packet generation.
4. Safe live run against Pocket Socrates.

Defer:

- `ai-redteam`
- `bug-hunt` replay orchestration
- video recording
- white-box mode
- auto PRs
