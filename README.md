# QA Harness

General QA, regression, and safe security/pentest harness with app-specific QA packs.

The current implementation is centered on the `pocket-socrates` pack, but the core is designed to become app-agnostic:

- load QA packs from `packs/<pack-id>/pack.yaml`
- run public/authenticated/browser QA smoke suites
- run Pro/Solo regression checks
- run long-thread and completion checks for AI apps
- run mobile, billing, language, workshop, and record/export smoke checks
- run safe HackZero-style security smoke and blackbox/whitebox pentest probes
- generate markdown/JSON summaries, screenshots, console/network artifacts, and draft-only finding packets

> Safety: this harness is for apps you own or are explicitly authorized to test. Pentest-style commands are intentionally non-destructive: no brute force, no spam/load tests, no payment abuse, no credential stuffing, and no destructive mutations.

---

## Install

```bash
npm install
```

## Verify

```bash
npx tsc --noEmit
npm test
```

Current verified test count at time of writing:

```text
42 test files
238+ tests
```

---

## Auth setup

Most authenticated and Pro commands need a Playwright storage-state file:

```text
.auth/pocket-socrates.json
```

### Save auth with Brave

Use this when Chromium/Google login is blocked:

```bash
npm run save-auth -- \
  --executable-path "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" \
  --user-data-dir ".auth\pocket-socrates-brave-profile" \
  --save-storage ".auth\pocket-socrates.json" \
  --url "https://pocketsoc.me/en/dashboard"
```

### Save auth from an already-open Brave CDP session

If Brave is running with remote debugging:

```bash
npm run save-auth-cdp -- \
  --endpoint "http://127.0.0.1:9222" \
  --save-storage ".auth\pocket-socrates.json"
```

---

## Basic QA commands

### Checklist

Print a track checklist from the pack:

```bash
npx tsx src/cli.ts checklist pocket-socrates basics
```

### Public HTTP smoke

Checks configured public routes for status/title/text expectations:

```bash
npx tsx src/cli.ts smoke pocket-socrates
```

### Public browser nav smoke

Checks public navigation links, footer links, safety route, and mobile hamburger behavior:

```bash
npx tsx src/cli.ts public-nav-smoke pocket-socrates \
  --output-dir artifacts/pocket-socrates/public-nav-smoke
```

### Early-access / TOS browser smoke

Checks TOS modal behavior, required checkboxes, and invite-code form behavior. Can write draft-only reports.

```bash
npx tsx src/cli.ts browser-smoke pocket-socrates \
  --output-dir artifacts/pocket-socrates/latest-browser-smoke \
  --draft-dir drafts/pocket-socrates
```

Known finding detected by this suite:

```text
Blank invite-code submit gives no visible validation message.
```

### Authenticated dashboard smoke

Skips safely if no storage-state is provided.

```bash
npx tsx src/cli.ts auth-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/auth-smoke
```

Checks authenticated dashboard rendering, nav labels, medical disclaimer handling, console errors, network failures, and HTTP 5xx.

---

## Pro / Crucible / AI regression commands

### Crucible smoke

Authenticated Crucible interaction smoke. Sends a Soc prompt only if the account has Solo/Pro access.

```bash
npx tsx src/cli.ts crucible-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/crucible-smoke
```

### Pro regression smoke

Short Pro/Solo regression check:

```bash
npx tsx src/cli.ts pro-regression-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/pro-regression-smoke \
  --turns 2
```

Checks:

- Pro paywall not visible for Pro account
- Solo input visible
- Soc responses captured
- style scanner runs on responses
- replies persist after refresh
- no premature `SESSION COMPLETE`
- export-before-summary behavior is graceful
- no console/network/5xx errors

### Long-thread smoke

Longer Soc thread regression for timeout/stage/persistence issues:

```bash
npx tsx src/cli.ts long-thread-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/long-thread-smoke \
  --turns 8 \
  --refresh-every 4
```

Checks:

- multiple turns get responses
- response time per turn is recorded
- stage/exchange count are recorded
- refresh persistence after configured turns
- no premature `SESSION COMPLETE`
- no console/network/5xx errors

### Completion smoke

Drives/checks a thread toward Landing/completion, or recognizes an already-completed thread:

```bash
npx tsx src/cli.ts completion-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/completion-smoke \
  --max-turns 10
```

Checks:

- stage timeline
- `SESSION COMPLETE` / Landing state
- completed-session summary text
- no crash/console/network/5xx errors

---

## Product surface smoke commands

### Record / Document / Export smoke

```bash
npx tsx src/cli.ts record-export-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/record-export-smoke
```

Checks Document tab / Working Documents surface and export empty-state behavior. It verifies graceful state, but actual PDF/download export requires a visible export control.

### Mobile authenticated app-shell smoke

```bash
npx tsx src/cli.ts mobile-auth-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/mobile-auth-smoke
```

Checks mobile viewport rendering, mobile drawer/menu access, Crucible input/state, console/network/5xx.

### Billing/account smoke

```bash
npx tsx src/cli.ts billing-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/billing-smoke
```

Safe check only: account page opens, billing/subscription controls are graceful, no destructive payment interaction.

### Language smoke

```bash
npx tsx src/cli.ts language-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --language vi \
  --output-dir artifacts/pocket-socrates/language-vi-smoke

npx tsx src/cli.ts language-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --language tr \
  --output-dir artifacts/pocket-socrates/language-tr-smoke
```

Current scope: menu/options smoke. Deep Soc generated-response language QA is still a future feature.

### Workshop / Roots / Echoes smoke

```bash
npx tsx src/cli.ts workshop-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/workshop-smoke
```

Checks visible Roots/Echoes/Workshop surface and graceful star interaction.

---

## Aggregate and CI runs

### All smoke

Runs the implemented major smoke suites and writes markdown/JSON summaries, artifacts, and draft-only failure reports.

```bash
npx tsx src/cli.ts all-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/all-smoke
```

### Timestamped CI mode

Creates:

```text
runs/<pack>/<timestamp>/
```

and prints compact output:

```bash
npx tsx src/cli.ts all-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --run-dir auto \
  --ci
```

---

## Changelog-targeted and chaos bug hunting

### Targeted changelog smoke

Checks selected Pocket Socrates Round 1 changelog items:

```bash
npx tsx src/cli.ts targeted-changelog-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/targeted-changelog-smoke
```

Optional non-Pro account state for Pro-bypass testing:

```bash
--non-pro-storage-state .auth/pocket-socrates-nonpro.json
```

Current targeted areas:

- Pro bypass exploit attempt, if non-Pro state is supplied
- `+ New Context` confirmation visibility
- close/start new session path
- export empty-state behavior
- light-mode language popover smoke
- topics deselect-save attempt
- mobile back-to-top button
- first-time onboarding / early-access gate

### Chaos smoke

Aggressive exploratory QA probes designed to find state/UI bugs:

```bash
npx tsx src/cli.ts chaos-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/chaos-smoke
```

Probes include:

- empty/double send
- refresh while generation is in progress
- rapid tab switching
- theme/language toggle chaos
- long multilingual special-character prompt
- console/network/5xx capture

---

## Safe security / pentest commands

These are HackZero-inspired features. They are intentionally safe/non-destructive and proof-oriented.

### Security smoke

```bash
npx tsx src/cli.ts security-smoke pocket-socrates \
  --storage-state .auth/pocket-socrates.json \
  --output-dir artifacts/pocket-socrates/security-smoke \
  --write-findings
```

Checks:

- security headers: CSP, HSTS, frame protection, Referrer-Policy, Permissions-Policy
- session cookie flags when observable
- exposed sensitive files: `/.env`, `/.git/config`
- public discovery files: `/robots.txt`, `/sitemap.xml`
- unauthenticated access to protected routes
- obvious private secret patterns in public bundles
- public sourcemap hints

Finding packets are written for medium/high failed checks when `--write-findings` is enabled.

Current confirmed/security-relevant issue found:

```text
Unauthenticated /en/account renders Account/settings UI instead of redirecting to sign-in.
```

### Blackbox pentest

URL-only safe pentest probes with confirmed replay:

```bash
npx tsx src/cli.ts blackbox-pentest pocket-socrates \
  --url https://pocketsoc.me \
  --output-dir artifacts/pocket-socrates/blackbox-pentest \
  --confirm-runs 2
```

What it does:

- starts with pack routes + common protected-looking routes
- probes protected routes unauthenticated
- records exact request metadata
- replays suspected findings `--confirm-runs` times
- only confirmed findings get finding packets

Confirmed finding output includes:

```text
finding.md
finding.json
replay.pw.ts
exact-request.http
replay.curl.sh
```

Example exact request artifact:

```http
GET /en/account HTTP/1.1
accept: text/html
host: pocketsoc.me
```

### Whitebox pentest

Repo-aware route discovery plus live probes:

```bash
npx tsx src/cli.ts whitebox-pentest pocket-socrates \
  --repo C:/path/to/repo \
  --url https://pocketsoc.me \
  --output-dir artifacts/pocket-socrates/whitebox-pentest \
  --confirm-runs 2
```

What it does:

- scans local repo source for route-like strings
- records file and line numbers in `whitebox-routes.json`
- prioritizes auth-looking routes: account, dashboard, admin, settings, billing, records, document, api, user, profile
- feeds prioritized routes into blackbox auth-gate probes

Important: true whitebox value requires the target app source repo. Running against this harness repo only proves the mechanism works.

---

## Finding packets

Security/pentest findings can generate HackZero-style draft packets:

```text
findings/<slug>/
  finding.md          # Notion-ready draft
  finding.json        # structured data
  replay.pw.ts        # Playwright replay scaffold
  exact-request.http  # exact HTTP request, when captured
  replay.curl.sh      # curl replay, when captured
```

`finding.md` is intentionally marked draft-only. The harness does not submit to Notion automatically.

---

## Scan and report commands

### Scan Soc/AI response text

```bash
npx tsx src/cli.ts scan pocket-socrates examples/soc-response.txt
```

Scans text against pack-specific style/rule violations.

### Validate/render report YAML

```bash
npx tsx src/cli.ts report pocket-socrates core examples/core-report.yaml
```

Validates and renders a Notion-ready markdown report from YAML.

---

## Documentation / PRDs

Product/spec docs live in:

```text
docs/prd/
  agentic-harness-01-run-contract-suite-registry.md
  agentic-harness-02-trace-evidence-replay.md
  agentic-harness-03-scenarios-datasets-graders.md
  agentic-harness-04-agent-runtime-safety.md
  agentic-harness-05-agentic-security-red-team.md
  agentic-harness-06-experiments-ci-monitoring-mcp.md
  agentic-harness-07-repository-integrity-release-baseline.md
  agentic-harness-08-evidence-trace-replay-integration.md
  agentic-harness-09-fixtures-datasets-graders.md
  agentic-harness-10-agent-redteam-e2e.md
  agentic-harness-11-ci-store-mcp-operations.md
  agentic-harness-remaining-implementation-plan.md
  agentic-harness-2026-research-roadmap.md
  hackzero-style-qa-security-platform.md
  security-smoke-implementation-spec.md
  blackbox-whitebox-pentest-spec.md
```

The remaining implementation plan and PRDs 07-11 define the ordered work required to make the current agentic harness reproducible, integrated, and release-ready.

The HackZero-style documents describe:

- blackbox pentest
- whitebox pentest
- confirmed replay
- finding packets
- exact request artifacts
- AI red-team direction
- MCP integration direction
- future fix-as-PR mode

---

## Architecture

```text
src/
  cli.ts                       command line entrypoint
  types.ts                     shared types
  pack.ts                      pack manifest loader + validation
  scanner.ts                   text/rule scanner
  report.ts                    report validator + markdown renderer

  smoke.ts                     public HTTP smoke
  browserSmoke.ts              early-access/TOS browser smoke
  publicNavSmoke.ts            public browser navigation smoke
  authSmoke.ts                 authenticated dashboard smoke
  crucibleSmoke.ts             Crucible/Solo smoke
  proRegressionSmoke.ts        short Pro/Solo regression
  longThreadSmoke.ts           long-thread regression
  completionSmoke.ts           Landing/completion regression
  recordExportSmoke.ts         Document/Record/export smoke
  mobileAuthSmoke.ts           mobile authenticated shell smoke
  additionalSmoke.ts           billing/language/workshop smoke
  targetedChangelogSmoke.ts    selected changelog verification
  chaosSmoke.ts                exploratory chaos probes

  securitySmoke.ts             safe security smoke checks
  pentest.ts                   blackbox pentest + replay confirmation helpers
  whiteboxPentest.ts           repo route discovery + whitebox probes
  findingPackets.ts            finding packet writer

  saveAuth.ts                  Brave auth-state capture
  saveAuthFromCdp.ts           CDP-based auth-state capture
  runSummary.ts                markdown/JSON summary helpers
  runDir.ts                    timestamped run directory helpers
  genericDrafts.ts             generic draft-only smoke failure reports
  draftReports.ts              app-specific draft reports

packs/
  pocket-socrates/
    pack.yaml                  first app-specific QA pack

examples/
  soc-response.txt
  core-report.yaml

docs/
  authenticated-checks.md
  crucible-smoke.md
  prd/
```

---

## Current known useful findings

### 1. Unauthenticated `/en/account` route renders Account/settings UI

Found by:

```text
security-smoke
blackbox-pentest
whitebox-pentest mechanism run
```

Artifacts:

```text
artifacts/pocket-socrates/security-smoke/
artifacts/pocket-socrates/blackbox-pentest/findings/unauthenticated-route-gated-en-account/
```

### 2. Blank invite-code submit has no visible validation

Found by:

```text
browser-smoke / all-smoke draft generation
```

Severity:

```text
Minor UX/form validation
```

---

## Release Status

The core harness is in an active development state with the following baseline:

```text
TypeScript: 95 source files, 45 test files
Tests:      42 files, 238+ tests passed
Suites:     18 registered suites
```

### Delivered (PRDs 01-06)

- Truthful execution statuses and suite registry
- Run coordination, retries, cancellation, resume, and trace spans
- Scenario and dataset schemas
- Deterministic graders and reliability helpers
- Bounded agent runtime primitives (policy engine, budgets, checkpoints, approvals)
- OWASP-aligned red-team definitions (attack mutations, canaries, harm endpoints)
- Experiments, comparison, gates
- Reporters (JUnit, SARIF, GitHub)
- OTel export
- Service API and MCP protocol handling

### In progress (PRDs 07-11)

The [remaining implementation plan](docs/prd/agentic-harness-remaining-implementation-plan.md) defines the ordered delivery:

1. **Repository Integrity & Release Baseline** — Fix ignored sources, commit all files, CI, empty-run policy
2. **Evidence, Trace & Replay Integration** — Real suites emit scoped evidence and executable replay
3. **Fixtures, Datasets & Graders** — Controlled fixtures, versioned datasets, state/trajectory grading
4. **Agent Runtime & Red-Team E2E** — Policy-controlled agents against fixtures
5. **CI, Result Store, MCP & Operations** — SQLite catalog, CI, MCP client access

### Still missing / next high-value work

1. Screen recording per finding (`video.webm`).
2. Real replay execution in `replay.pw.ts` instead of scaffold.
3. Exact request capture for browser/API flows beyond simple GET routes.
4. AI red-team mode for prompt-injection/system-prompt/data-leak probes.
5. True whitebox mode against the actual target app source repo.
6. Fix-as-PR mode for owned repos.
7. MCP server interface for external AI tools.
8. Scheduled recurring runs / continuous QA.
9. Compliance mapping to SOC 2 / HIPAA / PCI / ISO controls.
