# Operational (Non-Interactive) Examples

This directory contains example invocations for the qa-harness CLI and MCP
in non-interactive / CI / automated contexts. Every example is prompt-free and
deterministic.

## Running examples

All examples use the `fixture-web` pack, which starts a controlled local
web server and does not require any external service credentials.

```bash
# From the repository root
cd /path/to/qa-harness
```

---

## 1. Public (Unauthenticated) Run

Run the public-routes suite against the controlled fixture:

```bash
npm run qa -- run fixture-web --suite public-routes --headed=false
```

Or with the coordinator directly via the service:

```bash
npm run qa -- scheduled fixture-web --profile release
```

## 2. Authenticated Run (with storage state)

```bash
npm run qa -- run fixture-web \
  --suite health-check \
  --storage-state /path/to/storage-state.json \
  --headed=false
```

## 3. Dataset Evaluation

```bash
npm run qa -- eval fixture-web smoke --headed=false
```

## 4. Agent Evaluation (deterministic / fake provider)

```bash
npm run qa -- agent-eval fixture-web agent-smoke \
  --provider fake \
  --headed=false
```

## 5. Red-Team Evaluation

```bash
npm run qa -- redteam fixture-web \
  --dataset redteam \
  --split smoke \
  --provider fake \
  --headed=false
```

## 6. Comparison

```bash
# Run two baseline runs
npm run qa -- scheduled fixture-web --profile release
npm run qa -- scheduled fixture-web --profile release

# Compare them (replace run IDs with actual output)
npm run qa -- compare <baseline-run-id> <candidate-run-id>
```

## 7. Report Generation

```bash
# After a run, generate CI-compatible reports
npm run qa -- generate-report junit <run-id>
npm run qa -- generate-report sarif <run-id>
npm run qa -- generate-report github-summary <run-id>
```

## 8. MCP stdio Server

Start the MCP server for AI-agent integration (read-only by default):

```bash
npm run qa -- mcp
```

With run operations enabled:

```bash
QA_MCP_ALLOW_RUN=true npm run qa -- mcp
```

## 9. Retention (dry-run)

Preview which run directories would be cleaned up:

```bash
npm run qa -- retention --older-than-days 30
```

Apply retention:

```bash
npm run qa -- retention --older-than-days 30 --apply
```

## 10. Catalog Rebuild

Rebuild the catalog index from immutable run manifests:

```bash
npm run qa -- catalog-rebuild
```
