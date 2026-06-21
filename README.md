<div align="center">

# 🔴 RedHarness

**Test, probe, and prove your AI agents — in one harness.**

[![CI](https://github.com/AIWhispererDev/redharness/actions/workflows/ci.yml/badge.svg)](https://github.com/AIWhispererDev/redharness/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/redharness.svg)](https://www.npmjs.com/package/redharness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C/%3E-TypeScript-3178C6)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-719-passing-brightgreen)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

**`npm i -g redharness`** · **`npx redharness`** · **Agent eval · Red-team · Pentest · MCP**

---

[Why](#why-redharness) · [Quickstart](#quickstart) · [Features](#features) · [Packs](#packs) · [Security](#safe-security--pentest) · [MCP](#mcp) · [Docs](#documentation) · [Contributing](#contributing)

</div>

---

## Why RedHarness?

Most testing tools do one thing. **RedHarness does everything your agents need to go to production.**

| You want to… | Other tools make you… | RedHarness |
|---|---|---|
| Run regression on an AI app | Wire up Playwright + a test runner + custom reporters | `redharness pro-regression-smoke my-app --turns 5` |
| Pentest a web app safely | Use Burp Suite or custom scripts | `redharness blackbox-pentest my-app --url https://example.com` |
| Red-team your LLM | Build a prompt-injection framework from scratch | `redharness redteam my-app --dataset owasp-top10` |
| Evaluate an agent | Stitch together LangSmith + custom graders + traces | `redharness run my-suite --scenario agent-eval` |
| Compare model versions | Manual spreadsheets | `redharness experiment compare --baseline v1 --candidate v2` |
| Expose results to AI tools | Write yet another API | Built-in **MCP server** |

> **One CLI. 19 registered suites. 719 tests. Zero destructive payloads.**

---

## Quickstart

```bash
# Install
npm install -g redharness

# List available QA packs
redharness list

# Run a public smoke check
redharness smoke pocket-socrates

# Security smoke (headers, cookies, exposed files, auth gates)
redharness security-smoke pocket-socrates --write-findings

# Run everything
redharness all-smoke pocket-socrates --ci
```

No auth? No problem — smoke, pentest, and blackbox commands work without credentials.

---

## Features

### 🧪 Agent Evaluation
Run agents against versioned datasets. Grade on trajectory, state, rubric, rules, pairwise — or drop in a human reviewer.

```bash
redharness run agent-eval --scenario read-file --dataset fixture-v1
```

- **8 grader types**: deterministic, state, trajectory, rule, rubric, pairwise, composite, human
- **Bounded agent runtime**: policies, budgets, approvals, checkpoints, cancellations
- **Trace spans** with OTel export
- **Durable checkpoints** — pick up where you left off

### 🛡️ Red-Team Security
OWASP-aligned adversarial scenarios. Safe, non-destructive, evidence-first.

```bash
redharness redteam fixture-agent --dataset owasp-injection-2026
```

- **OWASP Top 10 for Agentic Apps 2026**: goal hijack, tool misuse, memory poisoning, rogue agents
- **Seeded trials**: deterministic reproduction across runs
- **Benign controls**: distinguish real failures from false positives
- **Finding packets**: Notion-ready reports with replay scripts

### 🔍 Safe Pentest
Blackbox and whitebox route discovery with **confirmed replay** — no repro, no finding.

```bash
redharness blackbox-pentest pocket-socrates --url https://pocketsoc.me --confirm-runs 2
```

- Security headers, cookie flags, exposed files, auth-gate bypass
- Sourcemap scanning, public bundle secrets
- **Wire-level replay**: exact HTTP request, curl, Playwright script
- Finding packets with `finding.md`, `replay.pw.ts`, `replay.curl.sh`

### 📊 Regression & Smoke
Browser-level QA suites for authenticated and public surfaces.

```bash
redharness pro-regression-smoke my-app --turns 5
redharness long-thread-smoke my-app --turns 12 --refresh-every 4
redharness chaos-smoke my-app
```

- Dashboard, mobile viewport, billing, language, workshop
- Chaos probes: double-send, mid-generation refresh, rapid tab switching
- Console/network/5xx capture on every check

### 🧠 MCP Server
Expose everything to AI agents via Model Context Protocol.

```bash
redharness mcp
```

Your AI assistant can list packs, start runs, poll status, cancel, compare, and inspect findings — governed by the same policy engine.

---

## Packs

RedHarness is pack-driven. Packs define routes, checks, graders, and issue types for any application.

```yaml
# packs/my-app/pack.yaml
id: my-app
name: My App
type: web
baseUrl: https://my-app.com
```

| Pack | Type | Status |
|------|------|--------|
| `fixture-agent` | Agent fixture | ✅ Deterministic CI |
| `fixture-web` | Web fixture | ✅ Release gating |
| `pocket-socrates` | AI reflection app | ✅ Live smoke |
| `scholars-xp` | Web app | ✅ Smoke ready |
| `gorilla-moverz` | Web app | ✅ Smoke ready |

**Create your own:** `packs/<app>/pack.yaml` — then run any command against it.

---

## Safe Security / Pentest

> **Safety first.** RedHarness is intentionally non-destructive:
> - No brute force, no credential stuffing, no spam
> - No payment abuse, no destructive mutations
> - Suspicious findings must be **replayed `--confirm-runs` times** before becoming confirmed
> - All finding packets are **draft-only** — nothing auto-submits

### What RedHarness found in the real world:

| Finding | Tool |
|---------|------|
| 🔴 Unauthenticated `/en/account` renders settings UI | `security-smoke`, `blackbox-pentest` |
| 🟡 Blank invite-code submit has no validation | `browser-smoke` |

---

## CLI

```bash
redharness <command> [pack] [options]
```

| Command | What it does |
|---------|-------------|
| `smoke` | Public HTTP smoke (status, title, text) |
| `public-nav-smoke` | Public browser navigation checks |
| `browser-smoke` | TOS/early-access gate checks |
| `auth-smoke` | Authenticated dashboard smoke |
| `crucible-smoke` | AI/Crucible interaction smoke |
| `pro-regression-smoke` | Pro/Solo regression (turns, persistence, export) |
| `long-thread-smoke` | Long-thread timeout/stage checks |
| `completion-smoke` | Session completion/Landing checks |
| `mobile-auth-smoke` | Mobile viewport + drawer smoke |
| `billing-smoke` | Safe billing/account surface check |
| `language-smoke` | Locale/language switching smoke |
| `workshop-smoke` | Roots/Echoes/Workshop surface check |
| `record-export-smoke` | Document/export empty-state check |
| `targeted-changelog-smoke` | Selected changelog verification |
| `chaos-smoke` | Aggressive exploratory UI probes |
| `security-smoke` | Headers, cookies, exposed files, auth gates |
| `blackbox-pentest` | URL-only safe pentest with confirmed replay |
| `whitebox-pentest` | Repo-aware route discovery + live probes |
| `redteam` | OWASP-aligned adversarial agent scenarios |
| `run` | Execute a registered suite against a pack |
| `experiment` | Compare baselines vs candidates |
| `mcp` | Start MCP server for AI agent access |
| `list` | List packs, suites, scenarios, datasets |
| `scan` | Scan text against pack style rules |
| `report` | Validate and render report YAML |
| `checklist` | Print a pack track checklist |

---

## Architecture

```
src/
├── cli.ts                    # CLI entrypoint
├── agent/                    # Bounded agent runtime (26 files)
│   ├── runtime.ts            # Policy-controlled agent executor
│   ├── policyEngine.ts       # Budgets, approvals, stop conditions
│   ├── checkpoints.ts        # Durable checkpoint/resume
│   └── browser/              # Governed browser tools
├── redteam/                  # OWASP-aligned security scenarios (13 files)
│   ├── attackRegistry.ts     # Attack mutation library
│   ├── datasetLoader.ts      # Versioned dataset loading
│   └── findingWriter.ts      # Notion-ready draft packets
├── scenarios/                # Scenario engine + dataset schemas
├── graders/                  # 8 grader types (deterministic → human)
├── experiments/              # Comparison, regression gates
├── core/                     # Run coordination, suite registry, status
├── mcp/                      # MCP server (AI agent access)
├── exporters/                # OTel, JUnit, SARIF, GitHub reporters
├── service/                  # Governed service API
└── reporters/                # Report renderers
```

---

## Documentation

Full PRD and spec docs: [`docs/prd/`](docs/prd/)

| Doc | What it covers |
|-----|---------------|
| [Run Contract & Suite Registry](docs/prd/agentic-harness-01-run-contract-suite-registry.md) | Truthful execution, suite registry |
| [Trace, Evidence & Replay](docs/prd/agentic-harness-02-trace-evidence-replay.md) | Unified trace spans, artifact store |
| [Scenarios, Datasets & Graders](docs/prd/agentic-harness-03-scenarios-datasets-graders.md) | Dataset schemas, 8 grader types |
| [Agent Runtime & Safety](docs/prd/agentic-harness-04-agent-runtime-safety.md) | Bounded agent, policy engine, budgets |
| [Agentic Security & Red-Team](docs/prd/agentic-harness-05-agentic-security-red-team.md) | OWASP 2026, attack mutations, findings |
| [Experiments, CI & MCP](docs/prd/agentic-harness-06-experiments-ci-monitoring-mcp.md) | Experiments, gates, OTel, MCP |
| [HackZero Security Platform](docs/prd/hackzero-style-qa-security-platform.md) | Pentest, finding packets, replay |

---

## Release Status

```
TypeScript: 138 source files, 0 errors
Tests:      84 files, 719 tests
Suites:     19 registered
License:    MIT
```

### ✅ Delivered
- Truthful execution, suite registry, run coordination, retries, cancel, resume
- 8 grader types (deterministic, state, trajectory, rubric, pairwise, composite, rules, human)
- Bounded agent runtime with policies, budgets, approvals, checkpoints
- OWASP 2026 red-team engine with seeded trials, benign controls, findings
- Safe blackbox/whitebox pentest with confirmed replay
- JUnit, SARIF, GitHub, OTel reporters
- SQLite catalog, baselines, findings, retention, scheduled workflows
- Policy-governed MCP server

### 🔄 In Progress
- Screen recording per finding (`video.webm`)
- AI red-team mode (prompt-injection, system-prompt leak, data-leak probes)
- Fix-as-PR mode for owned repos
- Compliance mapping (SOC 2 / HIPAA / PCI / ISO)
- Scheduled recurring runs / continuous QA

---

## Contributing

PRs welcome! The project needs help with:

- **New QA packs** — add your app to `packs/`
- **Graders** — new evaluation strategies
- **Attack scenarios** — OWASP-aligned or novel
- **Docs & examples** — make it easier for others to get started

```bash
git clone https://github.com/AIWhispererDev/redharness.git
cd redharness
npm install
npm test
```

---

<div align="center">

**🔴 RedHarness** — Test, probe, and prove your AI agents.

[GitHub](https://github.com/AIWhispererDev/redharness) · [npm](https://www.npmjs.com/package/redharness) · [Issues](https://github.com/AIWhispererDev/redharness/issues) · [PRs](https://github.com/AIWhispererDev/redharness/pulls)

</div>
