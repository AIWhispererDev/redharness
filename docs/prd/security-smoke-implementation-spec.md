# Security Smoke + Finding Packets Implementation Spec

> **For Hermes:** Use test-driven-development for every code change.

## Goal

Implement safe security smoke checks plus Notion-ready finding packet generation.

## Architecture

- `src/securitySmoke.ts`: runs safe black-box/authenticated security checks and renders a report.
- `src/findingPackets.ts`: converts failed checks into durable finding folders with markdown/json/replay scaffold.
- `src/cli.ts`: adds `security-smoke` command.
- `tests/securitySmoke.test.ts`: verifies rendering/classification.
- `tests/findingPackets.test.ts`: verifies packet files are generated.

## Data Model

```ts
type SecurityCheck = BrowserSmokeCheck & {
  severity?: 'info' | 'low' | 'medium' | 'high';
  category?: 'headers' | 'cookies' | 'exposure' | 'auth' | 'cors' | 'bundle';
};

type SecuritySmokeResult = {
  ok: boolean;
  skipped: boolean;
  checks: SecurityCheck[];
  artifacts: string[];
};
```

## Security Checks

### Header checks

Fetch base URL and inspect:

- `content-security-policy`
- `strict-transport-security`
- `x-frame-options` or CSP `frame-ancestors`
- `referrer-policy`
- `permissions-policy`

Missing headers are low/medium depending on importance.

### Cookie checks

Read `Set-Cookie` headers from base/auth pages when observable. Flag missing `Secure`/`SameSite` on session-like cookies.

### Public exposure checks

Try safe GETs:

- `/.env`
- `/.git/config`
- `/sitemap.xml`
- `/robots.txt`
- common sourcemap URL hints from scripts

Do not fuzz aggressively. Only fixed, safe paths.

### Unauthenticated protected routes

Open protected routes in a fresh context:

- `/en/dashboard`
- `/en/account`

Expected: redirect to sign-in/early access or render access gate, not protected content.

### Bundle secret scan

Fetch public JS bundles from landing page and scan for obvious private-key patterns:

- `sk_live_`
- `AKIA`
- `-----BEGIN PRIVATE KEY-----`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Do not flag public Clerk/publishable keys as high severity.

## Finding Packet Acceptance

Given a failed check, write:

```text
<outputDir>/findings/<slug>/finding.md
<outputDir>/findings/<slug>/finding.json
<outputDir>/findings/<slug>/replay.spec.ts
```

Markdown must be draft-only and Notion-ready.

## Verification Commands

```bash
npx tsc --noEmit
npm test -- tests/securitySmoke.test.ts tests/findingPackets.test.ts
npx tsx src/cli.ts security-smoke pocket-socrates --storage-state .auth/pocket-socrates.json --output-dir artifacts/pocket-socrates/security-smoke
```
