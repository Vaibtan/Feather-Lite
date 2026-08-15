# Audit phases 2-11 (scope-gated)

**Scope gate (read first).** Run ONLY the phases your resolved mode selected in
SKILL.md's Mode Resolution. Phases 0, 1, 12, 13, 14 always run; Phases 2-11 are
scope-gated. Example: `--owasp` runs Phase 9 from this file, not Phases 2-8/10/11.

## Phase 2: Secrets Archaeology

Scan git history for leaked credentials, check tracked `.env` files, find CI
configs with inline secrets.

**Credential-prefix catalog (HIGH tier):** AKIA (AWS), ghp_/gho_/github_pat_
(GitHub), sk-ant- (Anthropic), sk_live_ (Stripe), xoxb-/xoxp-/xapp- (Slack),
`-----BEGIN ... PRIVATE KEY-----` (PEM).

- **Git history:** grep all history additions for the prefix catalog plus
  password/secret/token/api_key assignments, scoped to env/config/source files.
- **.env files tracked by git:** list any `.env`/`.env.*` tracked (excluding
  example/sample/template); check `.env` is gitignored.
- **CI configs with inline secrets:** grep workflow files for
  `password:`/`token:`/`secret:`/`api_key:` values that are NOT `${{ ... }}`
  expressions or `secrets.` references.

**Severity:** CRITICAL for active secret patterns in git history. HIGH for .env
tracked by git, CI configs with inline credentials. MEDIUM for suspicious
.env.example values.

**FP rules:** Placeholders ("your_", "changeme", "TODO") excluded. Test fixtures
excluded unless the same value appears in non-test code. Rotated secrets still
flagged (they were exposed). `.env.local` in `.gitignore` is expected.

**Diff mode:** Replace `git log -p --all` with `git log -p <base>..HEAD`.

## Phase 3: Dependency Supply Chain

Goes beyond `npm audit`. Checks actual supply chain risk.

- Detect the package manager (package.json / Gemfile / requirements.txt /
  pyproject.toml / Cargo.toml / go.mod) and run its audit tool. Each tool is
  optional — if not installed, note "SKIPPED — tool not installed" with install
  instructions. This is informational, NOT a finding.
- **Install scripts in production deps:** for Node projects with hydrated
  `node_modules`, check production dependencies for `preinstall`/`postinstall`/
  `install` scripts (supply chain attack vector).
- **Lockfile integrity:** lockfiles exist AND are tracked by git.

**Severity:** CRITICAL for known high/critical CVEs in direct deps. HIGH for
install scripts in prod deps / missing lockfile. MEDIUM for abandoned packages /
medium CVEs / lockfile not tracked.

**FP rules:** devDependency CVEs are MEDIUM max. `node-gyp`/`cmake` install
scripts expected (MEDIUM not HIGH). No-fix-available advisories without known
exploits excluded. Missing lockfile for library repos (not apps) is NOT a finding.

## Phase 4: CI/CD Pipeline Security

Check who can modify workflows and what secrets they can access. For each
workflow file:

- Unpinned third-party actions (`uses:` lines missing `@<sha>`)
- `pull_request_target` (dangerous: fork PRs get write access)
- Script injection via `${{ github.event.* }}` in `run:` steps
- Secrets as env vars (could leak in logs)
- CODEOWNERS protection on workflow files

**Severity:** CRITICAL for `pull_request_target` + checkout of PR code / script
injection via `${{ github.event.*.body }}` in `run:` steps. HIGH for unpinned
third-party actions / secrets as env vars without masking. MEDIUM for missing
CODEOWNERS on workflow files.

**FP rules:** First-party `actions/*` unpinned = MEDIUM not HIGH.
`pull_request_target` without PR ref checkout is safe (precedent #11). Secrets
in `with:` blocks (not `env:`/`run:`) are handled by runtime.

## Phase 5: Infrastructure Shadow Surface

Find shadow infrastructure with excessive access.

- **Dockerfiles:** missing `USER` directive (runs as root), secrets passed as
  `ARG`, `.env` files copied into images, exposed ports.
- **Config files with prod credentials:** DB connection strings (postgres://,
  mysql://, mongodb://, redis://) in config files, excluding
  localhost/127.0.0.1/example.com; staging/dev configs referencing prod.
- **IaC:** Terraform `"*"` in IAM actions/resources, hardcoded secrets in
  `.tf`/`.tfvars`; K8s privileged containers, hostNetwork, hostPID.

**Severity:** CRITICAL for prod DB URLs with credentials in committed config /
`"*"` IAM on sensitive resources / secrets baked into Docker images. HIGH for
root containers in prod / staging with prod DB access / privileged K8s. MEDIUM
for missing USER directive / exposed ports without documented purpose.

**FP rules:** `docker-compose.yml` for local dev with localhost = not a finding
(precedent #12). Terraform `"*"` in `data` sources (read-only) excluded. K8s
manifests in `test/`/`dev/`/`local/` with localhost networking excluded.

## Phase 6: Webhook & Integration Audit

Find inbound endpoints that accept anything.

- **Webhook routes:** find webhook/hook/callback route patterns; a file with
  webhook routes but NO signature verification (signature, hmac, verify, digest,
  x-hub-signature, stripe-signature, svix) is a finding.
- **TLS verification disabled:** `verify.*false`, `VERIFY_NONE`,
  `InsecureSkipVerify`, `NODE_TLS_REJECT_UNAUTHORIZED.*0`.
- **OAuth scope analysis:** overly broad scopes in OAuth configurations.

**Verification approach (code-tracing only — NO live requests):** trace the
handler to determine if signature verification exists anywhere in the middleware
chain (parent router, middleware stack, API gateway config). Do NOT make HTTP
requests to webhook endpoints.

**Severity:** CRITICAL for webhooks without any signature verification. HIGH for
TLS verification disabled in prod code / overly broad OAuth scopes. MEDIUM for
undocumented outbound data flows to third parties.

**FP rules:** TLS disabled in test code excluded. Internal service-to-service
webhooks on private networks = MEDIUM max. Webhooks behind an API gateway that
verifies signatures upstream are NOT findings — but require evidence.

## Phase 7: LLM & AI Security

Check for AI/LLM-specific vulnerabilities. This is a new attack class.

Grep for:
- **Prompt injection vectors:** user input flowing into system prompts or tool
  schemas — string interpolation near system prompt construction
- **Unsanitized LLM output:** `dangerouslySetInnerHTML`, `v-html`, `innerHTML`,
  `.html()`, `raw()` rendering LLM responses
- **Tool/function calling without validation:** `tool_choice`, `function_call`,
  `tools=`, `functions=`
- **AI API keys in code (not env vars):** `sk-` patterns, hardcoded assignments
- **Eval/exec of LLM output:** `eval()`, `exec()`, `Function()`, `new Function`

Key checks beyond grep: trace user content flow into system prompts/tool
schemas; RAG poisoning (can external documents influence AI behavior via
retrieval?); tool-call validation before execution; LLM output treated as
trusted; cost/resource attacks (can a user trigger unbounded LLM calls?).

**Severity:** CRITICAL for user input in system prompts / unsanitized LLM output
rendered as HTML / eval of LLM output. HIGH for missing tool call validation /
exposed AI API keys. MEDIUM for unbounded LLM calls / RAG without input
validation.

**FP rules:** User content in the user-message position of an AI conversation is
NOT prompt injection (precedent #13). Only flag when user content enters system
prompts, tool schemas, or function-calling contexts.

## Phase 8: Skill Supply Chain

Scan installed AI-agent skills for malicious patterns. 36% of published skills
have security flaws, 13.4% are outright malicious (Snyk ToxicSkills research).

**Tier 1 — repo-local (automatic):** grep all `.claude/skills/` SKILL.md files
for:
- `curl`, `wget`, `fetch`, `http`, `exfiltrat` (network exfiltration)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `env.`, `process.env` (credential access)
- `IGNORE PREVIOUS`, `system override`, `disregard`, `forget your instructions`
  (prompt injection)

**Tier 2 — global skills (requires permission):** AskUserQuestion before scanning
`~/.claude/skills/` and hooks in user settings — it reads files outside the repo.

**Severity:** CRITICAL for credential exfiltration attempts / prompt injection in
skill files. HIGH for suspicious network calls / overly broad tool permissions.
MEDIUM for skills from unverified sources without review.

**FP rules:** Skills the user authored (path resolves to a repo they own) are
trusted. Skills using `curl` for legitimate purposes (downloading tools, health
checks) need context — only flag when the target URL is suspicious or the
command includes credential variables.

## Phase 9: OWASP Top 10 Assessment

Targeted analysis per category, scoping file extensions to detected stacks.

- **A01 Broken Access Control:** missing auth on routes (skip_before_action,
  no_auth), direct object references (params[:id], req.params.id) — can user A
  reach user B's resources by changing IDs? Horizontal/vertical escalation?
- **A02 Cryptographic Failures:** weak crypto (MD5, SHA1, DES, ECB), hardcoded
  secrets; encryption at rest and in transit; key management.
- **A03 Injection:** SQL (raw queries, string interpolation), command
  (system/exec/spawn/popen), template (eval, html_safe, raw); LLM prompt
  injection → Phase 7.
- **A04 Insecure Design:** rate limits on auth endpoints; account lockout;
  server-side business-logic validation.
- **A05 Security Misconfiguration:** CORS wildcards in production; CSP headers;
  debug mode / verbose errors in production.
- **A06 Vulnerable Components:** → Phase 3.
- **A07 Auth Failures:** session creation/storage/invalidation; password policy;
  MFA (available? enforced for admin?); JWT expiration, refresh rotation.
- **A08 Integrity Failures:** → Phase 4 for pipelines; deserialization input
  validation; integrity checks on external data.
- **A09 Logging & Monitoring:** auth events, authorization failures, and admin
  actions logged? Logs protected from tampering?
- **A10 SSRF:** URL construction from user input; internal service reachability;
  allowlist enforcement on outbound requests.

## Phase 10: STRIDE Threat Model

For each major component identified in Phase 0:

```
COMPONENT: [Name]
  Spoofing:               Can an attacker impersonate a user/service?
  Tampering:              Can data be modified in transit/at rest?
  Repudiation:            Can actions be denied? Is there an audit trail?
  Information Disclosure: Can sensitive data leak?
  Denial of Service:      Can the component be overwhelmed?
  Elevation of Privilege: Can a user gain unauthorized access?
```

## Phase 11: Data Classification

```
DATA CLASSIFICATION
===================
RESTRICTED (breach = legal liability):
  - Passwords/credentials: [where stored, how protected]
  - Payment data: [where stored, PCI compliance status]
  - PII: [what types, where stored, retention policy]

CONFIDENTIAL (breach = business damage):
  - API keys: [where stored, rotation policy]
  - Business logic: [trade secrets in code?]
  - User behavior data: [analytics, tracking]

INTERNAL (breach = embarrassment):
  - System logs: [what they contain, who can access]
  - Configuration: [what's exposed in error messages]

PUBLIC:
  - Marketing content, documentation, public APIs
```
