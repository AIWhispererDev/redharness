# Agentic Harness 2026 Research and Build Roadmap

## Document Status

- Status: Proposed
- Research cutoff: June 19, 2026
- Scope: Evolution of this repository from an application-specific QA runner into a general, evidence-first agent evaluation and security harness
- Audience: Product, QA, security, and implementation agents

## Executive Decision

The harness should not add an autonomous bug-hunting agent as its next feature.

The next build must establish a trustworthy execution and evaluation substrate:

1. truthful run semantics and a suite registry;
2. unified traces, evidence, and executable replay;
3. scenario datasets, graders, and repeated trials;
4. a bounded agent runtime with approvals and budgets;
5. agentic security and red-team scenarios;
6. experiment comparison, CI gates, monitoring, and MCP interoperability.

An autonomous explorer built before phases 1-3 would amplify the current weaknesses: skipped checks can appear green, `all-smoke` is incomplete, most behavior is hard-coded, and finding replay is still a scaffold.

## What Is Current as of June 19, 2026

This roadmap was checked against primary documentation and recent research available through June 19, 2026.

### Standards and current framework guidance

- OpenAI recommends beginning with end-to-end traces, then adding graders, datasets, and repeatable eval runs. Trace grading covers model calls, tool calls, guardrails, and handoffs.
- Inspect AI treats datasets, scorers, sandboxes, tool approvals, limits, retries, resumption, parallelism, checkpointing, and trace analysis as first-class evaluation infrastructure.
- Google ADK evaluates both the final response and the trajectory/tool use. Its current criteria include exact trajectory matching, rubric-based tool-use quality, multi-turn task success, multi-turn trajectory quality, and user simulation.
- LangSmith distinguishes offline dataset evaluation from online production-trace evaluation, and treats experiments as versioned runs containing outputs, scores, and traces.
- Playwright trace files preserve action history, DOM snapshots, network activity, console output, and errors. This is richer and more reproducible than the harness's current screenshot-plus-JSON approach.
- OpenTelemetry now has a dedicated GenAI semantic-conventions project covering model, agent, tool, workflow, planning, memory, and MCP spans. These conventions are still marked Development, so this harness should use a compatible internal schema without making them a permanent storage dependency.
- MCP is the appropriate interoperability boundary for exposing harness tools, resources, run status, and findings to external agents. MCP security guidance explicitly addresses least privilege, confused-deputy risks, token passthrough, and session hijacking.

### 2026 security guidance

The OWASP Top 10 for Agentic Applications 2026 defines:

1. ASI01 Agent Goal Hijack
2. ASI02 Tool Misuse and Exploitation
3. ASI03 Identity and Privilege Abuse
4. ASI04 Agentic Supply Chain Vulnerabilities
5. ASI05 Unexpected Code Execution
6. ASI06 Memory and Context Poisoning
7. ASI07 Insecure Inter-Agent Communication
8. ASI08 Cascading Failures
9. ASI09 Human-Agent Trust Exploitation
10. ASI10 Rogue Agents

OWASP's June 2026 governance report says the threat model is no longer hypothetical. It calls for live behavioral monitoring, drift baselines, automated incident routing, stop mechanisms, dedicated agent identities, budget limits, audit trails, and controls proportional to autonomy and blast radius.

### 2026 research signals

- SafeClawBench, submitted June 16, 2026, demonstrates that semantic attack acceptance, audit-visible evidence, and actual sandbox/state harm are distinct outcomes. Agentic security evaluation must report them separately.
- AgentDyn argues that static and simplistic prompt-injection suites miss dynamic, open-ended tasks and helpful third-party instructions. Security scenarios therefore need dynamic environments and benign utility measurement, not only hostile prompts.
- Seven Simple Steps for Log Analysis in AI Systems argues for structured, reproducible analysis of tool/user interaction logs rather than ad-hoc inspection.
- Recent deep-research benchmarks combine deterministic verifiers with expert rubrics and adversarial cognitive traps. A single regex scanner or a single LLM judge is insufficient for decision-grade evaluation.
- Tau-bench introduced `pass^k` to measure whether an agent succeeds consistently across repeated trials. One successful or failed run is not a reliability measurement.
- DeltaBox reflects a broader 2026 direction toward checkpointable, rollback-capable stateful agent sandboxes. This repository does not need millisecond rollback initially, but its runtime and result schemas must support checkpoints and resumable attempts.

## Current Repository Assessment

### Strengths

- Real browser and authenticated application testing
- Safe black-box and white-box route discovery
- Replay confirmation for a subset of HTTP route findings
- Screenshots, console logs, network failures, and structured summaries
- Pack validation with Zod
- Long-thread, completion, mobile, chaos, and product-surface checks
- Draft-only finding packets and explicit non-destructive safety posture

### Critical gaps

1. `all-smoke` executes only five suites and omits most implemented capabilities.
2. Missing authentication commonly produces `ok: true`, so skipped required coverage can result in a green aggregate run.
3. Run summaries discard skipped/error/attempt information and retain only a boolean.
4. Most workflows, selectors, prompts, routes, and assertions are embedded in suite modules rather than pack/scenario data.
5. Finding replay files contain placeholder assertions instead of executable reproduction logic.
6. There is no common event or trace model connecting browser actions, HTTP requests, model turns, tool calls, graders, and evidence.
7. There are no datasets, dataset versions, experiment baselines, repeated trials, or reliability statistics.
8. There is no model/provider abstraction, agent loop, tool registry, approval policy, sandbox policy, or resource budget.
9. Security checks primarily cover traditional web controls, not agent goal, tool, memory, identity, or inter-agent risks.
10. Unit tests mostly verify renderers and helpers rather than end-to-end harness behavior against controlled fixtures.

## Ordered Delivery Plan

| Phase | PRD | Outcome | Required before next phase |
|---|---|---|---|
| 1 | [Run contract and suite registry](agentic-harness-01-run-contract-suite-registry.md) | Truthful statuses, complete suite discovery, retries, resume, and CI policy | Aggregate runs cannot be green when required coverage is skipped or errored |
| 2 | [Trace, evidence, and replay](agentic-harness-02-trace-evidence-replay.md) | Unified event traces, Playwright traces, evidence manifests, and real replay | A failed scenario can be inspected and replayed from its packet |
| 3 | [Scenarios, datasets, and graders](agentic-harness-03-scenarios-datasets-graders.md) | Declarative scenarios, versioned datasets, graders, trials, and reliability metrics | Behavior can be compared across versions without editing runner code |
| 4 | [Agent runtime safety](agentic-harness-04-agent-runtime-safety.md) | Provider-neutral bounded agent execution, tools, approvals, checkpoints, and budgets | No unbounded or unapproved agent action is possible |
| 5 | [Agentic security red team](agentic-harness-05-agentic-security-red-team.md) | OWASP-aligned adversarial scenarios and staged harm measurement | Security findings distinguish semantic, evidence, and state harm |
| 6 | [Experiments, CI, monitoring, and MCP](agentic-harness-06-experiments-ci-monitoring-mcp.md) | Baselines, regression gates, trends, scheduled runs, OTel export, and MCP API | External agents and CI can safely launch and inspect governed runs |

## Architecture Direction

The target architecture has six layers:

```text
CLI / MCP / CI
      |
Run coordinator and suite registry
      |
Scenario engine and agent runtime
      |
Tools / browser / HTTP / model adapters
      |
Trace, artifact, replay, and result store
      |
Graders, experiments, baselines, and findings
```

Existing suites should become adapters registered in the run coordinator. They should not be rewritten all at once. Migration is incremental:

1. wrap existing suite results in the new run contract;
2. centralize shared browser instrumentation;
3. extract repeated behavior into scenario steps;
4. retain specialized TypeScript suites where declarative scenarios are insufficient.

## Cross-Cutting Product Rules

### Truth before convenience

- `passed`, `failed`, `skipped`, `error`, and `cancelled` are distinct.
- A required skipped suite fails the release gate unless explicitly waived.
- Harness infrastructure errors must never be reported as product failures.

### Evidence before findings

- Every confirmed finding references attempt IDs, trace spans, and artifacts.
- Secrets and authentication material are redacted at capture time.
- Security findings require state/effect evidence when the claimed impact is an external action.

### Reliability before anecdotes

- Stochastic scenarios support multiple trials.
- Report success rate, `pass@1`, `pass^k`, latency distribution, and confidence intervals where sample size allows.
- A single LLM judge cannot be the sole release gate for a high-severity result.

### Least agency

- Default tools are read-only.
- High-impact actions require policy approval and a dry-run preview.
- Every run has time, turn, tool-call, network, and optional token/cost budgets.
- A kill switch and cancellation path are mandatory before autonomous exploration.

### Portable internals

- Internal traces should map cleanly to OpenTelemetry GenAI/MCP concepts.
- Storage must remain usable without an external observability vendor.
- MCP exposure is an adapter over the same service API used by CLI and CI.

## Source Register

### Primary documentation

- [OpenAI: Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)
- [Inspect AI: Running evals](https://inspect.aisi.org.uk/running.html)
- [Inspect AI: Eval sets](https://inspect.aisi.org.uk/eval-sets.html)
- [Inspect AI: Setting limits](https://inspect.aisi.org.uk/setting-limits.html)
- [Inspect AI: Tool approval](https://inspect.aisi.org.uk/approval.html)
- [Inspect AI: Agent checkpointing](https://inspect.aisi.org.uk/checkpointing.html)
- [Inspect AI: Tracing](https://inspect.aisi.org.uk/tracing.html)
- [Google ADK: Agent evaluation](https://adk.dev/evaluate/)
- [LangSmith: Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts)
- [Playwright: Trace viewer](https://playwright.dev/docs/trace-viewer-intro)
- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [OpenTelemetry GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [OpenTelemetry MCP spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)
- [PyRIT 0.14 documentation](https://microsoft.github.io/PyRIT/0.14.0/)
- [Promptfoo red-team guide](https://www.promptfoo.dev/docs/red-team/)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [OWASP State of Agentic AI Security and Governance 2.01](https://genai.owasp.org/resource/state-of-agentic-ai-security-and-governance/)

### Research papers

- [SafeClawBench](https://arxiv.org/abs/2606.18356)
- [AgentDyn](https://arxiv.org/abs/2602.03117)
- [Seven Simple Steps for Log Analysis in AI Systems](https://arxiv.org/abs/2604.09563)
- [DeltaBox](https://arxiv.org/abs/2605.22781)
- [Tau-bench](https://arxiv.org/abs/2406.12045)
- [AgentDojo](https://arxiv.org/abs/2406.13352)
- [BrowserGym](https://arxiv.org/abs/2412.05467)
- [Evaluating Deep Research Agents on Expert Consulting Work](https://arxiv.org/abs/2605.17554)
- [DREAM: Deep Research Evaluation with Agentic Metrics](https://arxiv.org/abs/2602.18940)

Research papers are design evidence, not normative standards. Features derived from preprints should be validated against this harness's actual product needs before becoming permanent APIs.
