# Feather-Lite: working local product and subsequent pilot readiness

Date: 2026-10-04. Status: implementation specification prepared for review and delegation; no implementation is claimed by this document. Baseline: `4968c86430b1c6987a698a4352e356d47dd2f2b5` plus the existing working tree. Inspect that tree before editing; it contains unrelated setup and documentation work.

## 1. Authority, outcome and scope

This is the authoritative umbrella specification for the next delivery. It incorporates the [pilot-readiness findings](../reviews/2026-10-04-pilot-readiness-and-remaining-work.md), [local-product decisions](../reviews/2026-10-04-local-product-scope-and-clef-assessment.md), and unfinished work from the [September 5 specification](2026-09-05-attribution-contract-instruments-and-self-hosted-turn-taking-spec.md). Historical documents remain evidence, not evidence of current completion. Where priorities, human handling, deployment scope or workflow instructions conflict, this document and current `AGENTS.md` govern. Do not repeat already completed attribution work or follow historical instructions to commit automatically.

Deliver a real collections voice product that runs locally through Docker, persists its work, makes real browser and controlled telephone calls, schedules callbacks, records valid promises, routes human work to a staffed queue, and exposes working local observability. The operator interface must exercise the same services as calls and jobs. A fixture-driven presentation, disconnected dashboard, or simulated telephone result does not satisfy delivery.

There are two release boundaries:

- **L — local product:** all requirements marked L below, using synthetic borrower/account data and controlled consenting call participants. Hosted speech and language-model services are allowed. Local product, persistence, media services and observability run through Docker. This is the first implementation assignment.
- **P — real-borrower pilot:** all L requirements plus lender integration, approved operating policy, staffing, deployment and live acceptance gates in section 12. Intended jurisdiction/role: US collection for another lender. L completion is not authorization to contact real borrowers.

Accepted decisions: staffed follow-up instead of live transfer; internal staff queue first; real product UI; local Docker; hosted inference allowed; Clef deferred. Engineering defaults specified here are proposed implementation choices, not claims that the user chose a particular vendor or legal policy. An implementer may adjust a default with a documented compatibility or measurement reason while preserving its acceptance criteria; material scope changes need user direction.

Out of scope for L: Clef installation/inference/shadow calls, live human bridging, payment processing, vector memory/RAG, an end-to-end speech-model rewrite, self-hosted model inference, general multitenant billing/campaigns, Kubernetes/HA rollout, automatic provider spending, and paid platform experiments. Section 11 explicitly disposes of unfinished research work rather than silently dropping it.

## 2. Preserve the existing architecture and guarantees

Use TypeScript, pinned Effect 3.22 and existing workspace boundaries. Follow [ADR 0005](../adr/0005-typescript-effect-not-go.md), [ADR 0010](../adr/0010-patch-the-worker-shed-load-at-the-worker-and-measure-before-cutting.md), and [TypeScript/Effect conventions](../agents/typescript-effect.md). Keep pure policy in `packages/domain`, schemas/contracts at boundaries, cohesive I/O services and adapters in the control plane, media lifecycle in the worker, and composition in application entry points. Avoid a broad framework rewrite.

Preserve these invariants in every phase:

1. T1 claims a turn, model/network work runs outside the transaction, and T2 revalidates ownership before committing tools. Superseded or expired owners cannot commit.
2. A promise uses the stored proposal's exact amount/date and segment identity. Voice confirmation requires nonempty, uninterrupted completion of that exact read-back. An early yes, another segment, replay, timeout, or classifier result is not evidence of completion. Preserve the intended held-input behavior: park an early yes during a noninterruptible read-back, then process it once after that exact segment completes, provided the proposal is still current and no correction/stop superseded it. Incomplete/interrupted playback never authorizes commitment. Simulation bypasses remain explicitly identified and cannot count as voice evidence.
3. Deterministic business confirmations follow durable commit. Ordinary streamed model text is not automatically post-commit; prevent uncommitted promises or false transfer/completion claims in that stream too.
4. Events remain append-only with stable sequence ordering. Repairs append evidence; do not rewrite history to make a run pass.
5. Missing evidence is unknown/incomplete, not success. Provider dispatch accepted, participant connected, speech played, business outcome committed, human case resolved, and payment received are distinct facts.

## 3. Requirements and finding traceability

All rows are L unless the boundary explicitly says P. Requirement IDs are stable acceptance references; implementation evidence must use them.

| ID | Finding / current seam | Required result |
| --- | --- | --- |
| SEC-01 | P01; HTTP app/handlers/config | Authenticated, role- and object-authorized reads/writes; separate worker identity; controlled origins; isolated destructive capabilities |
| POL-01 | P02; pre-call, Workflow, Scheduling | Versioned eligibility decisions, durable restrictions, correct history scope and serialized dispatch reservation; P approves real policy and evidence |
| TALK-01 | P03; opening/voicemail and evaluation | Identity/disclosure sequence that withholds protected content; truthful scripts and verifiable playback; P approves scripts |
| TEL-01 | P04; VoiceSessions/Scheduling | Shared typed dispatch with destination, reconciliation and actual SIP callback proof |
| CASE-01 | P05; transfer/follow-up jobs | Durable staffed cases with ownership, acknowledgment, due time and resolution; no false transfer completion |
| INT-01 | P06; overrides | Callback and negation regressions fixed; explicit stops preserved; ambiguity handled safely |
| ACT-01 | P07; tools/state machine | One action contract; valid end/human actions and proposal abandonment in all relevant states |
| VAL-01 | P08; schemas/tool execution | Strict real calendar/timestamp parsing and separate date, amount and freshness rules |
| LOAN-01 | P09; context/repositories | Stable workflow loan and borrower binding through reads and writes |
| DATA-01 | P10; CRM/operator workflow | Versioned import/export, status/payment reconciliation and real console workflows; P validates lender adapter |
| REC-01 | R01; turns/jobs/worker presence | Crash-safe turn leases, instance identity, replay/reconnect and external-effect reconciliation |
| EVAL-01 | R02; media/evaluation/scores | Evaluation of a versioned completed or explicitly incomplete media snapshot |
| MEAS-01 | R03; metrics/Quality/harness | Valid timing boundaries, consistent cohorts and fail-closed behavioral acceptance |
| OPS-01 | R04; deployment/operations | Reproducible persistent Docker product, recovery, support controls and release evidence |
| OBS-01 | R04 plus tracing/score mirror | Full local operational telemetry plus Langfuse, durable score export and privacy controls |
| VOICE-01 | September phases 1–4 / D2, D4 | Missing instruments/scenarios, bounded deterministic fast path and act-aware silence |

### 3.1 SEC-01 — access and destructive operations

Protect all borrower, loan, conversation, transcript, event, quality, export and case routes, including GET and streaming routes. Only minimal liveness and required authentication endpoints may be public. Readiness/metrics are internal or authenticated. Authorize the selected lender/project and linked object on every request; a supplied conversation/loan ID is not authorization. Validate origin/CSRF on cookie-authenticated mutations and restrict CORS to configured product origins.

Default identity design: local Docker Keycloak with a persistent realm and operator/administrator roles; server-mediated OIDC authorization code flow with PKCE and an HttpOnly session cookie. Use established libraries, explicit issuer/audience validation and session expiry/logout; do not invent password authentication or put long-lived operator tokens in browser storage. Local HTTP exceptions must be confined to documented loopback development settings; remote exposure requires TLS and secure cookies. Worker credentials are separate scoped service credentials, rotatable and restricted to worker callbacks/turn/media operations for assigned sessions. Worker identity cannot browse accounts or administer cases. Administrator permission is not a blanket bypass of lender scope.

Verify the selected Keycloak version/configuration against its [Docker guide](https://www.keycloak.org/getting-started/getting-started-docker) during implementation. Its development-mode example is not the P deployment configuration.

Remove public seed/reset from normal product routing. Explicit development tools use an isolated synthetic database, profile flag, database identity/sentinel check and privileged developer path. The normal application DB role must not be able to truncate its business tables. `DEMO_MODE=false` alone is not the guard. Verify flags are actually passed through Compose. Fixture labels stay visible, and creation is explicit/idempotent; startup never reseeds or truncates existing data.

Acceptance: anonymous and wrong-role reads/writes/streams fail; cross-object IDs fail; expired/revoked credentials fail; operator and worker permissions differ; bad origins/CSRF fail; normal profile cannot reset, seed or mutate harness scenarios; destructive tests reject the normal database even with a mistaken flag. Test with at least two principals and two scoped object sets without building a multitenant product.

### 3.2 POL-01 and TALK-01 — contact permission and protected speech

Introduce a pure eligibility evaluator and an I/O service that assembles facts and records its decision. Contract includes `ALLOW | DEFER | BLOCK | REVIEW`, reason codes, evaluated-at time, policy version, evidence/source revisions and optional next-eligible-at. Inputs include person, particular debt, contact/channel, borrower-local IANA zone, current clock, external and local attempts/conversations, consent basis and provenance, restrictions and source freshness. Unknown required consent/evidence cannot silently mean eligible. Policy configuration must distinguish applicable exceptions from defaults; seven attempts is not a universal safe harbor.

Persist restrictions with subject/scope, reason, source event, effective time, optional expiry and authorized release audit. Model disputes, hardship review, representation, deceased/wrong-party information, revocation and inconvenient times distinctly. A case closing does not automatically remove a restriction. Contact-level invalidity must not accidentally become borrower-wide suppression; explicit applicable revocation must not be reduced to a mere contact annotation.

Apply policy when scheduling and immediately before dispatch. Serialize eligibility/reservation under a shared person/debt lock or equivalent DB constraint so two jobs cannot both consume the last allowed attempt. Count across numbers and ingest external activity. Update restriction facts using the same serialization boundary. Recheck canceled reservations before network submission; if restriction arrives after an external submission began, record the race, attempt cancellation when supported, and reconcile. Do not claim a transaction can atomically control a telephone provider.

For L, ship a named **synthetic policy** with explicit conservative configuration, seeded consent evidence, timezone and data-freshness rules, and tests for multiple debts/numbers, recent conversations, DST, revoked consent, representation, stale feeds and changed eligibility. Reject unknown zones instead of guessing. P requires lender/counsel-approved policy and exception definitions for the actual states, debt types, technology and channel.

Replace debt-revealing opening/voicemail defaults. Create a versioned flow for greeting, right-party/verification evidence, required disclosures, account discussion, wrong-party handling and voicemail. Do not speak debt purpose, balances, lender/account details or collection-identifying voicemail copy before the policy allows it. Right-party assertion and identity verification are separate evidence states; do not describe conversational confirmation as strong authentication. Approved verification must minimize sensitive data spoken or collected. Deterministic speech segments carry purpose and script version; interrupted disclosures remain incomplete and resume/repeat according to policy before protected discussion. Explicit stop/end signals remain effective during this sequence.

Use a fictional local organization and configured controlled callback number for L. Provide safe behavior when verification fails, another person answers, voicemail detection is uncertain, or no valid callback number exists. Evaluators must check the new order and observed segment completion; remove rewards for the current unsafe opening. P supplies approved disclosures, recording policy, voicemail text and verification standard. This spec defines engineering controls, not a legal certification.

### 3.3 INT-01, ACT-01, VAL-01 and LOAN-01 — bounded correctness repairs

**Intent:** correct override patterns before introducing any classifier. Contrastive fixtures must include ordinary callback requests containing “call,” explicit no-more-calls requests, negated hardship, mixed hardship/payment statements, ambiguous cessation language and “wait, I can pay Friday.” Preserve explicit stops immediately. Ambiguity leads to a bounded clarification or paused collection with review, not irreversible borrower-wide opt-out by keyword. Store the observed reason/evidence for protective actions. Tests must assert business effect and suppression scope, not just a matched label.

**Actions:** derive model-exposed actions and executor/state permissions from one domain definition. `end_call` and `request_human` must work in every supported nonterminal conversational state, including greeting, verification, discussion and pending confirmation; normal outcome selection still follows policy. Keep forced runtime recovery privileged. Exiting confirmation abandons the proposal and cannot commit a promise. Enumerate state/action pairs in meaningful contract tests and exercise the real tool execution seam. Do not expand every tool to every state to silence validation errors.

**Values:** separate format decoding from business validation. Reject impossible dates and timestamp rollover such as February 30; timestamp contracts require explicit zone/offset as appropriate. Resolve relative dates against an injected clock and the borrower's zone, and clarify ambiguous DST/local dates. Reject past payment dates and past callback instants at execution; same-day payment is allowed only when the configured policy permits it. Configure maximum promise horizon, currency, minimum/maximum amount and balance constraints for synthetic data, then replace with approved lender terms for P. Represent money exactly in minor units or the repository's exact decimal convention, never floating-point rounding that changes a promise. Revalidate the stored proposal against current facts at confirmation and request a new read-back if terms become stale; do not silently change them.

**Loan binding:** load context by `workflow.loan_id` and verify borrower ownership. Validate existing workflow reuse against both borrower and loan. Scope balance, promise and status updates to the same binding. Highest delinquency is allowed for initial explicit selection, never for silently changing a running conversation. Test two loans whose ranking changes mid-call, a mismatched workflow ID, and a balance update between proposal and confirmation.

## 4. TEL-01 and REC-01 — calls, turns and recovery

### 4.1 Shared dispatch and external uncertainty

Define one versioned dispatch schema used by initial calls, callbacks and retries. It includes stable dispatch/attempt/conversation/workflow IDs, borrower/loan/contact references, the normalized destination snapshot (including current `contact_point_value` semantics), channel, worker assignment and trace correlation. Validate E.164, eligibility and metadata before dispatch. The worker rejects incomplete metadata with a durable reason visible to the operator; it must not disappear into a generic timeout.

Persist a dispatch intent before network work. Suggested states: `READY -> SUBMITTING -> ACCEPTED -> CONNECTED -> FINISHED`, with `CANCELED`, `FAILED` and `UNKNOWN` branches. Preserve provider identifiers and state evidence; acceptance is not connection. Use provider-supported idempotency where verified. On timeout after submission or a crash between provider acceptance and DB update, reconcile by stable dispatch identity/room/participant/provider evidence. An uncertain attempt cannot be blindly redialed. If the provider cannot prove whether the side effect occurred, retain UNKNOWN and require an operator decision; make that decision auditable. Scheduled jobs finish only after their specific dispatch/case/export contract is satisfied.

Local SIP requires the separate LiveKit SIP service and its Redis integration, not only the existing LiveKit server and trunk ID. Add pinned, compatible containers/configuration and a preflight for advertised IP, transport, SIP/RTP reachability, credentials and trunk routing on Windows Docker Desktop. Browser calls and phone legs use the same product conversation path. A local network that cannot support RTP is an explicit unresolved delivery gate; do not quietly substitute a cloud media plane and call it local completion. See the [LiveKit self-hosted SIP guide](https://docs.livekit.io/transport/self-hosting/sip-server/).

Acceptance: initial outbound and scheduled callback both reach a controlled participant, exchange audio in both directions, record the correct destination/attempt and terminate correctly. Invalid metadata or a newly ineligible account creates no new leg. Crash after submission does not duplicate dialing. Provider failure and unknown acceptance are visible and recoverable. General inbound PSTN routing is outside L unless separately chosen; the staffed callback number must have a documented real answering arrangement before P.

### 4.2 Durable turn ownership and worker presence

Replace process-map cleanup as the sole recovery mechanism with DB-backed turn leases: owner instance, lease expiry, monotonically advancing fence/generation and status. Use DB time for ownership comparisons. Extend leases during legitimate work, reclaim expired work, and make T2 conditional on the current owner/fence. Abort/failure cleanup releases only its own claim. Model failure, HTTP/SSE disconnect, worker crash and hard server termination must not strand a conversation forever or let a late model result commit. Never hold a DB transaction open over inference or speech.

Identify every worker supervisor and job instance uniquely; a shared display name cannot overwrite another heartbeat. Preserve media-plane confirmation before orphan finalization. Recover simulations as well as voice sessions. On client reconnect, return committed turn/outcome state plus replay cursor; do not regenerate tools or replay already spoken audio indiscriminately. If playout state is uncertain, retain incomplete evidence and use an explicit recovery path.

L defaults to one admitted live call and an explicitly bounded server/worker deployment. Enforce the cap in shared state or enforce the single-instance topology; per-process counters cannot imply a global limit. Multi-process DB claim tests are still required for races in jobs and leases. Higher concurrency is enabled only after fresh capacity evidence. Tests kill/restart at T1, inference, T2, dispatch acceptance and outbox acknowledgment; assert no duplicate promise, case, dial or acknowledgment and no stale-owner commit.

## 5. CASE-01 and DATA-01 — complete operator and lender loops

### 5.1 Staffed follow-up

Create a durable case in the same transaction as the relevant outcome/restriction and outbox intent. Use a unique escalation key so replay cannot create duplicates. Suggested states: `NEW -> ASSIGNED -> IN_PROGRESS -> RESOLVED`, with authorized reassignment and `CANCELED` plus reason. A due-time breach is derived as overdue, not a competing lifecycle state. Store lender/borrower/loan/conversation references, reason codes, safe summary, priority, required response time, owner, acknowledgment time, version and append-only activity/resolution evidence.

Claim/assignment and state changes use optimistic versions or row locks; concurrent claims have one winner and a typed conflict. Acknowledgment is a durable staff action, not case creation or notification delivery. Resolution requires disposition and notes appropriate to the reason. Permission to release a policy hold is separately checked and audited. Dispute, hardship, human request, representation and contact correction must remain distinguishable even if they share a queue.

Replace the transfer stub and premature HUMAN_FOLLOWUP completion. End the AI conversation with truthful configured follow-up wording only after the case commits; do not say someone has answered, transferred or will call by an unstaffed deadline. A human follow-up job may succeed when durable case creation succeeds, but that must not mark the case resolved. Notification failure cannot lose the case and should retry independently. The local queue itself is the delivery mechanism; external ticketing/email is not required for L.

Console flows: filter new/assigned/overdue cases, claim, acknowledge, view relevant account/conversation evidence, record an attempted follow-up, schedule an eligible callback, resolve with reason and audit, and show remaining restrictions. Proposed synthetic default: due in one business day using explicit test business hours/timezone; label it as local policy. P replaces this with staffed hours, coverage and escalation SLA. Acceptance includes duplicate trigger, two staff claim race, restart, overdue case, failed notification and resolution without accidental hold release.

### 5.2 Account input, exports and reconciliation

Build a real versioned file import/export adapter first (CSV/JSON as appropriate), behind services that can later support the lender's API. Import contracts include lender external keys, borrower/contact/loan links, currency/balance/status, timezone, evidence references, external attempt/conversation history, source revision/as-of and an import idempotency key. Validate the entire record graph before applying it; expose row errors, receipt and accepted/rejected counts. Define atomicity per batch or record and make partial success explicit. Reimport is idempotent; stale revisions cannot overwrite newer facts. A fresh source revision must not erase locally recorded restrictions.

Export outcomes, promises and follow-up cases with stable event IDs/revisions, delivery receipts/acknowledgments and retry/dead-letter visibility. Distinguish exported from acknowledged. Reconcile paid, withdrawn, disputed, changed balance and incorrect-party updates, including canceling or suppressing pending calls. A promise-to-pay is not a collected payment; fulfillment requires a matching lender/payment reference. Never infer payment from a completed voice call.

The product UI must support login, account/loan selection, import results, eligibility reasons, browser call, authorized outbound call, callbacks, conversation history, proposal/outcome evidence, case queue, failed jobs and replay/reconciliation actions. Empty/loading/error states and typed conflicts must be usable. Existing engineering transcript/quality views may remain secondary views. Do not expose trace internals as mandatory steps for an operator to complete work. A local synthetic import and a real acknowledged file export satisfy L; they do not constitute a verified lender integration.

### 5.3 Mutation and persistence contracts

Extend the existing typed HTTP API rather than adding unvalidated ad hoc handlers. Expose eligibility inspection, call/callback creation and cancellation, case list/detail/claim/acknowledge/transition/activity, import validation/application/receipt, export acknowledgment and failed-job reconciliation. Scope and authorize every operation. Return typed validation, forbidden/not-found, conflict, ineligible, provider-unavailable and uncertain-dispatch errors with safe operator-facing reasons.

Externally retried mutations carry an idempotency key scoped to principal/lender and operation plus a canonical request hash: same key/same payload returns the original result; same key/different payload conflicts. Case and other competing updates also carry expected version. Store the receipt with the business mutation, not after the response. Define retention for receipts so retries cannot accidentally become new actions. Enforce durable uniqueness for case escalation keys, provider dispatch identities, import source revisions, exported event revisions and score export revisions. Use FKs and ownership checks for linked records, and indexes for due/claimable work. Transactional outbox intents commit with their source mutations; adapters acknowledge separately. List endpoints use bounded pagination and stable ordering. Update generated contracts and console/worker consumers together, with compatibility tests for rolling changes.

## 6. EVAL-01 — media completion and score correctness

Business finalization is not media completion. Track media lifecycle separately, for example `ACTIVE -> DRAINING -> COMPLETE | INCOMPLETE`. DRAINING waits for named final-segment reports and metrics flush, with a bounded deadline. Disconnect, missing acknowledgment or deadline expiry yields INCOMPLETE with reasons, not fabricated completion. Do not rely on a fixed sleep after outcome commit.

Each evaluation captures a stable snapshot key containing the conversation, maximum relevant event sequence, media revision, evaluator/prompt/policy versions and source cohort. Persist that key with every score. Late accepted playout/metrics evidence increments the revision and schedules recomputation; stale evaluators cannot overwrite the current revision. Retain historical revisions for audit. Media-dependent scores on incomplete evidence must abstain or explicitly report incomplete, while independently valid business facts may still be reported.

Keep external judging and telemetry outside DB transactions. Judge failures/abstentions are distinct from negative verdicts and missing labels. Store human labels, judge version and per-dimension evidence with adjudication status. Show sample size, class counts, abstentions and calibration state. Do not label judge probabilities, agreement or prevalence estimates as calibrated without the required labeled evaluation. Advanced corrected-prevalence work is data-gated in section 11.

Acceptance: delayed final audio, duplicate report, interrupted closing, disconnect, late metrics and concurrent reevaluation all produce the correct revision without lost scores. Replaying the same snapshot is idempotent; evaluating an earlier snapshot cannot win over a later one.

## 7. OBS-01 — observability architecture and deliverables

OpenTelemetry and Langfuse serve different purposes here. OTel is the instrumentation/transport foundation; the operational backends provide storage/querying/alerts; Langfuse supplies LLM decision inspection and evaluation views. Retain Postgres as the authoritative business/event/score store. Neither a trace nor Langfuse acknowledgment authorizes a business action.

### 7.1 Local topology

| Signal | Collection and destination | Required use |
| --- | --- | --- |
| Operational traces | One OTel provider per process -> Collector -> Tempo | Request, turn, scheduler, provider and recovery causality |
| Structured logs | OTel log pipeline -> Collector -> Loki native OTLP | Correlated failures and state transitions without raw sensitive content |
| Metrics | Prometheus scrapes application/worker/exporter endpoints | Histograms, queues, reliability, capacity and alerts |
| Model spans/evaluations | Existing Langfuse integration, sharing the process tracing provider | Generation input/output under privacy policy, model usage, versions, sessions and score revisions |
| Business truth | Postgres events, projections, cases and scores | Auditable workflow and replay/reconciliation |
| Operator telemetry UI | Provisioned Grafana plus local Langfuse | Queryable dashboards and trace/decision drill-down |

Compose must include Collector, Prometheus, Grafana, Loki, Tempo and the existing Langfuse web/worker plus its Postgres/ClickHouse/Redis/object-storage dependencies. Reconcile the current separate Langfuse Compose file into one documented startup workflow with compatible networks and explicit environment wiring; merely leaving a second unused stack in `deploy/` does not pass. Pass Langfuse enablement, endpoint and keys to all intended processes. Use persistent named volumes and loopback bindings for admin UIs. Protect UIs and keep storage/ingestion ports internal. Do not share LiveKit Redis keys or business DB privileges with unrelated subsystems; separate instances or explicitly isolated supported databases/roles as appropriate.

Initialize tracing before instrumented imports. Add the Langfuse processor/export path to the same provider instead of registering competing global providers. Decide and document which spans reach Langfuse, avoiding duplicate generations and blanket export of account payloads. Reuse the pinned SDK if compatible; verify any upgrade against installed types and primary docs. Configure bounded Collector queues/retry, persistent buffering where supported, memory limits and dropped-item metrics. Telemetry failure must not block audio or business commit; no retry storm or unbounded memory. A separate acceptance health check must show telemetry degraded even if calls remain available.

Primary references for implementation: [Collector resilience](https://opentelemetry.io/docs/collector/resiliency/), [Tempo Docker deployment](https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/deploy/locally/docker-compose/), [Loki OTLP ingestion](https://grafana.com/docs/loki/latest/send-data/otel/), [Langfuse OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry). Select exact compatible image versions/digests and record them during implementation; these documentation URLs do not authorize floating `latest` tags.

### 7.2 Correlation, timing and privacy

Instrument actual execution, including failed/canceled generation, not just reconstructed successful work after T2. Required spans: authenticated HTTP/stream request, T1, decision/fast path, provider request, T2, scheduling claim/dispatch, STT/endpointing, TTS/playout, media report, outbox/evaluation/export and case mutations. Record monotonic durations within a process; do not subtract unrelated process clocks for an alleged accurate latency. Propagate validated W3C trace context across HTTP, worker metadata and durable job envelopes. Use span links for delayed jobs/new traces rather than keeping a days-long call trace open.

Use stable conversation/turn/segment/attempt/case IDs and run/version metadata for joins. IDs belong in traces/log fields, not unbounded Prometheus labels. Separate decision source (`model`, `fast_path`, `override`, `scripted`, `none`) from model/provider identity and outcome/disposition; define a single enum mapping used on wire, in storage, harness and UI. Capture build, prompt, policy, model/configuration, SDK and media versions.

Redact before exporting: names, numbers, addresses, account identifiers, credentials, verification answers and raw audio are forbidden by default in logs/metrics/traces. Use allowlisted attributes and sanitized error/score comments. Synthetic fixtures may opt into richer Langfuse content; real-data export requires approved redaction/retention/access rules. Test canary sensitive values in model content, exceptions and score comments and search the actual telemetry stores for leakage. Business records retain necessary protected evidence under application access controls. Raw audio recording is off unless explicitly configured with policy and retention.

### 7.3 Durable score mirror and operational views

Replace volatile pending-score loss with a DB export outbox committed with each score revision. Export stable score IDs/revision keys, bounded retries/backoff, dead letters and last error; never clear unacknowledged items on failure. Reconcile uncertain writes and avoid duplicate remote scores. Networking must not run inside the scoring transaction. Langfuse unavailability leaves correct local scores and visible pending exports; recovery eventually converges to the current revision.

Provision dashboards and saved queries in source: service health/resource use; admitted/active/failed calls; end-of-speech latency and stage diagnostics; tool and policy rejections; callback dispatch status; case age/overdue/acknowledgment; turn lease reclamation and stale workers; outbox/evaluation/export lag; quality cohorts and missing evidence; Collector/backend drops and availability; model latency/token/cost estimates with provenance. Link a product conversation to authorized Tempo and Langfuse inspection. Cost estimates must be labeled when provider billing is unavailable.

Provision Grafana alert rules and a local durable webhook receiver for exercising delivery without sending external messages. Required alerts: API/worker absence, stuck turn/dispatch, failed/unknown callback, overdue human case, growing outbox/export lag, telemetry loss, disk pressure and observed latency breach with minimum sample count. Each alert has severity, owner, threshold/window and runbook; startup silence and a healthy zero-call period must not page. External destinations and on-call ownership are configured for P. Test both firing and resolution and retain the received notification.

L acceptance: one controlled call is findable by conversation ID in the product ledger, Tempo, correlated Loki logs and Langfuse; its metrics appear in provisioned Grafana panels and its persisted score revision matches the mirror. Interrupt and restart the Collector/Langfuse during traffic; calls still complete, backlog/drop behavior is visible, and durable score exports catch up. Restart the stack without deleting volumes and query earlier data. Initial local retention target: metrics seven days, logs/traces three days, synthetic Langfuse records seven days; enforce backend-supported retention or a documented tested maintenance procedure plus disk limits. P replaces these with approved retention/deletion rules.

## 8. MEAS-01 and VOICE-01 — trustworthy measurement before tuning

### 8.1 Timing, cohorts and acceptance semantics

Define each timing metric with start/end events, clock owner, unit and missingness. End-of-speech to first audible response measured at a controlled receiving participant is the acceptance metric. Worker first-output timing is a proxy and must be labeled. SDK end-of-utterance/transcription quantities that share an anchor overlap; do not add them as disjoint stages. Model TTFT, TTS first audio, queueing and media delay remain diagnostic intervals with their own boundaries.

Implement histograms with documented buckets/units, counts and missing samples. Use one cohort selector shared by Quality, status, reports and harness: channel, simulation/harness origin, run ID, conversation/turn decision source, time window, build/model/policy configuration and completion status. Do not compare a mixed population to a real-voice SLO or drop slow/failing calls from its denominator. Show business correctness, conversational quality and operational availability separately. Missing WER/reference audio is unknown, not zero error.

Initial performance gate after correctness is preserved: measured receiving-participant p95 response latency at or below 2.5 seconds for the declared baseline cohort, with count, failures, missingness and machine/network configuration reported. For the bounded deterministic fast path, target p50 below 700 ms on its eligible cohort. These are acceptance targets from the existing direction, not achieved claims or permission to weaken guards. If missed, capture the failed gate and bottleneck; do not silently change thresholds. L single-call evidence does not establish N=10 capacity.

### 8.2 Harness repairs and scenarios

Create an explicit acceptance mode: every required scenario must satisfy its assertions and any missing evidence/infrastructure fails that run. Historical `expectedFail`/diagnostic scenarios may remain for research but cannot yield a green delivery gate. Assert tool arguments, amounts/dates, case/suppression effects, segment IDs and ordering, not just tool names. Fix resource sampling to select actual running service containers, including per-instance workers and observability costs.

Required scenarios: clean promise; exactly one early yes during read-back with no later yes to rescue it; interrupted/empty/wrong read-back segment; amount/date correction; ordinary callback vs opt-out; negated hardship; human request during confirmation; wrong party/verification failure; voicemail/uncertainty; explicit stop during opening/hold; hold/errand/bare wait with measured quiet audio; backchannel and substantive interruption; 600–1200 ms mid-sentence pause; 4–8 second pause after a response; third-party participant; degraded/accented audio; provider timeout; disconnect/reconnect; callback after changed eligibility; two-loan binding; restart/final-media delay. Use controlled synthetic scripts and real audio where the assertion is acoustic.

Restore the prior seeded event mix: intra-line pauses with probability 0.10, one interruption at a random agent-line boundary with probability 0.30 per line, and a backchannel with probability 0.01 per agent clause, plus a seeded thinking pause after each agent reply. Treat it as a reproducible stress cohort distinct from natural prevalence. Add the agent-backchannel measurement hook (agent audio onsets inside a borrower line), including judge transcript markers, without adding unsolicited agent-backchannel speech.

Expose the six existing [turn-taking metrics](../../packages/domain/src/turnTaking.ts): response rate, yield rate, yield latency, false-interrupt rate, agent-interrupt rate and selectivity, with denominators and unknown truncation. Add the pending T90 interrupt-offset sweep and `stt.entity_er` alongside `stt.wer`, labeled as harness metrics with the cohort/segment named. Sweep endpointing only after baseline capture; report cut-off/recovery and entity-error tradeoffs. Require zero critical amount/date corruption on the required suite. Do not present a single scripted WER threshold as a universal borrower-quality measure; retain the historical reference threshold only for its matched fixture cohort and report missing labels.

The single-early-yes scenario must prove `heldMs > 0`, exactly one read-back and one commitment after full segment completion, with no second yes emitted by the harness. A paired interrupted/missing-playout variant must prove no commitment. A final promise outcome alone cannot establish either behavior.

### 8.3 Instruments, deterministic decisions and silence

Carry the currently missing decision source, disposition, speak mode, endpointing probability, VAD trigger/duration and transcript-relative observations through typed contracts into storage/UI. Surface existing turn-taking metrics, wait/resume misses and confirmation escape counters with denominators. Keep segment attribution by contract and existing normalized resume vocabulary; do not restore mutable-turn inference.

Implement the previously planned pure `classifyIntent` fast path for finalized utterances only: narrowly unambiguous affirmation/denial or supported amount/date amendment in confirmation, and explicit hold handling in discussion. Its confidence is an eligibility indicator (0/1), not calibrated probability. Mixed clauses, hedges, unclear dates, multiple amounts and ambiguous intent fall through to the current decider. All fast-path actions use the same executor, policy, ownership and read-back guards. Never commit from interim ASR. Test positive and contrastive negative cases and expose source-specific timing/outcomes. Retain the original scenario parity gate (20/20 plus new scenarios), zero fast-path tool rejection for correctly eligible fixtures, and no measured regression in the matched model-path baseline. Interim prefetch remains deferred.

Type the last agent act and derive silence policy from it, using an explicit table and clock. Proposed L defaults preserve current conservative waits: 12 seconds for ordinary questions/read-back response, 5 seconds for bare hold, 15 seconds for errand hold and 15 seconds for nudge grace. No borrower silence timer runs while a required disclosure or terminal closing is playing; restart eligible timers after attributed playout. Preserve existing noninterruptible segment/held-turn behavior. Test cancellation, repeated hold, substantive resume, terminal state and race with late playout. Any tighter timings require measured before/after evidence and cannot break early-yes or amount/date gates.

## 9. OPS-01 — packaging, migration and operations

Build and serve the actual console in Docker, including hashed assets and SPA routing; the current server image alone does not package it. Use a same-origin product endpoint through an explicit static/reverse-proxy arrangement or correctly implemented server asset handling. Include app Postgres, identity, API, worker, LiveKit, SIP/Redis, full observability and a one-shot migration/bootstrap workflow. Browser WebRTC/microphone origins and TLS/loopback behavior need a tested documented configuration. Hosted inference endpoints and credentials remain external.

Supply `.env` examples without secrets, pinned images/dependency versions, health checks, dependency readiness, resource limits, persistent volumes and PowerShell-compatible startup/doctor/verification commands. Default to one active call and minimal warm workers. The doctor reports Docker availability, ports, memory/disk allocation, credentials presence (never values), provider connectivity, SIP network readiness and telemetry query readiness. Record peak CPU/RSS/container memory and total stack use on the actual machine; retain headroom instead of assuming the full stack fits. A reduced diagnostics profile may help development but cannot pass full-observability acceptance.

Migrations are additive first: ownership/lease fields, restrictions/policy decisions, dispatch intents, cases/activity, import/export receipts, media/score revisions and telemetry export outbox as needed. Inventory existing rows and report invalid/orphaned/ambiguous references before adding constraints. Backfill only facts supported by evidence: legacy verification, human completion, consent or playout cannot be invented. Mark unknown legacy data and keep it ineligible where required. Preserve old events and existing valid promises. Use explicit unique keys/FKs/indexes and test migration from a representative prior schema with data as well as a clean DB.

Deploy compatible readers/writers before requiring new fields; version worker metadata and reject unsupported versions predictably. Document schema/code rollback boundaries. Take a backup before migration; rollback must not mean dropping newly recorded business work. Demonstrate restore into a separate database and reconcile counts/representative event sequences/cases. Bootstrap and ordinary restarts are idempotent. Development cleanup must never reset normal volumes.

Add operator controls for pausing new dispatch, canceling an eligible pending callback, inspecting/retrying failed work, reconciling UNKNOWN attempts and reading audit history. Pausing admissions stops new calls without corrupting active ones. Graceful shutdown drains or records incomplete media and releases claims; hard kill recovers through leases. Provide runbooks for provider outage, database restart, SIP one-way audio, stale worker, stuck turn, overdue case, export backlog, telemetry outage, disk exhaustion and backup restore.

## 10. Implementation sequence and evidence gates

Work in the following order; each phase leaves the product usable and records evidence. Apply affected tests while iterating. Do not implement everything first and postpone integration until the end.

| Phase | Work | Exit evidence |
| --- | --- | --- |
| 0 | Reconcile baseline/dirty tree, instructions, service seams and migration design; establish isolated test DB and evidence index | Exact HEAD/diff inventory, runnable current checks, named gaps; no destructive test against app DB |
| 1 | INT-01, ACT-01, VAL-01, LOAN-01; shared TEL metadata; preserve promise invariant | Regressions fail before/fix after; relevant domain/unit/DB tests; contract compatibility |
| 2 | SEC-01, policy/restrictions, safe speech, CASE-01, DATA-01 and real console workflows | Authorization matrix, policy cases, staff claim/restart, import/export reconciliation and UI walkthrough |
| 3 | Dispatch reconciliation, turn leases/presence, EVAL-01, durable score outbox | Crash/race matrix on real isolated Postgres; stable revisions, no duplicate side effects |
| 4 | Complete Docker product/media/auth and OBS-01; repair MEAS-01 | Persistent full stack, trace/log/metric/Langfuse queries, alert firing/resolution, outage recovery and resource report |
| 5 | VOICE-01 and harness gaps; browser and controlled PSTN end-to-end validation | Fresh baseline and acceptance report; exact read-back, callback and case proof; stated latency gate result |
| 6 | Migration/restore/release rehearsal, docs and remaining pilot checklist | Clean-start and restart walkthrough, restore receipt, evidence for every L ID, honest unresolved gates |

Provider calls need credentials, controlled destination allowlist, participant permission and an agreed spending cap before they run. Missing external inputs block only dependent tests: continue code, deterministic tests, database/container work and diagnostics that are authorized. Never fabricate live proof or substitute scripted runs in the release verdict.

Minimum automated verification: affected package suites, `pnpm check` for substantive code changes, affected deployable builds when entry points/bundling change, schema/contract compatibility, and DB integration tests for migrations, locks, unique keys, fencing and revisions. `pnpm test:db` truncates data: create and verify a separate test DB/role and sentinel; change the test harness so a missing/mistaken URL cannot target normal product data. Use behavioral test Layers at service seams, not implementation-shaped mocks. Anti-slop/lint is opt-in and is not added to normal checks or CI by this assignment.

Fresh external acceptance: browser voice plus initial SIP and scheduled callback to controlled numbers; one correct promise, held early-yes behavior and rejection when playout remains incomplete, opt-out, failed verification and a staffed follow-up; staff acknowledgment/resolution; late media evaluation; killed-process recovery; telemetry outage/catch-up; restore. Run at least two complete sequential passes of the required scenario suite with zero invariant violations, and a declared latency cohort large enough to report useful percentiles (initial minimum 30 completed turns across at least five calls). Include failed and missing samples in reporting. This minimum establishes a local baseline, not population-level reliability or a pilot concurrency claim.

Store a dated implementation report under `docs/reviews/` containing requirement-to-test/run links, commands/exit statuses, sanitized configuration and image versions, migration/restore evidence, counts/latency distributions/resources, known limitations and blocked external inputs. Each requirement is `not started`, `implemented/unverified`, `verified`, or `blocked` with a reason. A green unit suite or healthy container alone cannot change a live requirement to verified. Historical artifacts are labeled historical; earlier audit checks are not rerun claims.

## 11. Original roadmap disposition and deferred work

| Earlier item | Disposition under this spec |
| --- | --- |
| September phase 0: segment attribution/read-back protection | Preserve and regression-test; do not rebuild completed mechanism. Historical N=5 gates are not fresh acceptance. |
| Phase 1: endpointing instruments and vocabulary | Keep landed EOT/resume work; complete missing fields, VAD/transcript alignment, escape counters and visible turn/entity metrics in MEAS-01/VOICE-01. |
| Phase 2: pause/backchannel/third-party/degradation/event-mix scenarios | Complete in L with acoustic evidence and fail-closed harness semantics. |
| Phase 3 / D2: deterministic confirmation/hold fast path | Complete bounded version in L; interim speculation/prefetch deferred until measured benefit and cancellation semantics justify it. |
| Phase 4 / D4: act-aware silence | Complete typed policy in L using conservative defaults; tune only against measured cohort. |
| Phase 5: SDK/SFU upgrades | Conditional follow-on after baseline, or earlier only for a demonstrated blocker. Old suggested target versions are historical. Verify current compatible versions, inventory patches, run regression/performance comparison and retain rollback. |
| SmartTurn shadow, LiveKit Cloud A/B, TTS pooling/first-clause optimization, provider priority tiers, multi-server/resampling experiments | Deferred measured backlog. Require a specific bottleneck/hypothesis, provider budget and isolated baseline; no architecture switch based on paper/vendor numbers. |
| Phase 6: ADR/documentation | Required in L: record final handoff, auth, media/evaluation and telemetry decisions using the next available ADR number, update runbooks and status without rewriting historical results. |
| D6: judge abstention/calibration and corrected prevalence | Implement abstention, labels, versioning and honest uncalibrated displays in L. Sensitivity/specificity estimation, uncertainty intervals and corrected-prevalence publication require an adequate adjudicated labeled set and documented methodology before use; do not fabricate labels or apply correction to mixed cohorts. |
| Clef | Explicitly deferred. Keep a clean decision seam but add no Cloudflare dependency, token requirement, classifier call or acceptance dependency now. Revisit the existing research after this baseline. |
| Vector-index stub | Not needed for L/P core workflow; expose as unsupported/disabled rather than successful useful work. No vector store implementation in this assignment. |

## 12. Additional P gates and decisions still needed

These do not prevent building L with synthetic configuration. They must be resolved before real-borrower operation, and may add policy-specific implementation after selection.

| Gate | Required external decision/evidence |
| --- | --- |
| Policy authority | Lender and qualified counsel approve covered states/debt types, contact restrictions/consent or exemption evidence, external-history completeness, verification, disclosure/recording/voicemail wording, callback number and notices/dispute handling. Revalidate current rules rather than treating this spec as legal advice. |
| Lender source of truth | Select actual integration/export process, identifiers, reconciliation/freshness SLAs, payment/status feeds and acknowledgment ownership. Exercise it with permitted test records and failure/recovery evidence. |
| Staff operations | Named case owners, staffed hours, holidays/timezone, response SLA, escalation coverage, dispute/hardship/representation procedures and who can release restrictions. Demonstrate overdue routing and a completed staffed rehearsal. |
| Telephony and hosting | Provider/trunk, allowed destinations, numbers, consented test participants, budget, reachable network/TLS, secrets management and supported deployment. Complete PSTN callback and no-answer/failure tests. |
| Privacy and retention | Approved access, encryption, backup, transcript/audio/telemetry export and deletion schedules; audit actual stores and access paths. Local synthetic defaults are insufficient. |
| Operational release | Named alert recipients, rollback/stop procedure, restore evidence, supervised launch cap, measured headroom and incident response. Start at the proven cap; increase only on fresh tests. |
| Quality release | Review errors and false protective actions on representative labeled calls, require zero known critical policy/amount/date failures in the acceptance suite, and explicitly accept measured limitations. No generic “accuracy” score substitutes for these gates. |

The next implementing agent should finish all independent L work and document unresolved external gates precisely. It must not call the whole product complete while PSTN, telemetry querying, persistence or required recovery evidence is missing. The handoff entrypoint is [implementation handoff](2026-10-04-implementation-handoff.md).
