# Local product milestone and Clef classifier assessment

Date: 2026-10-04. This records clarified scope and research conclusions before the implementation specification. No model inference, provider spending, application changes or deployment was performed.

## Accepted scope

The user selected staffed follow-up rather than immediate human telephone transfer. Implement a real work queue: durable cases, ownership, acknowledgment, due times, status changes, resolution and overdue visibility. Speech must describe follow-up accurately. An AI conversation ending does not complete the human case. The exact staffing hours and SLA remain inputs to the later pilot specification.

The first delivery milestone is a working product running locally through Docker that can be demonstrated to prospective users. The user explicitly rejected a presentation-only demo UI. The console must operate real persistence, calls, callbacks, outcomes and human cases. Hosted speech and language-model services are acceptable; all inference does not need to run on the local machine. Real-borrower pilot readiness remains the subsequent release gate.

This updates the priority of the [pilot-readiness review](2026-10-04-pilot-readiness-and-remaining-work.md). It does not erase its correctness findings. The human-path choice in that review is now resolved.

For the local milestone, proposed acceptance is:

- Reproducible Docker startup, migrations, health checks and persistent application data.
- Real operator workflows for accounts, calls, callbacks, promises and staffed follow-up cases. Development data is isolated and clearly synthetic; operator actions use the actual application services.
- Real browser voice plus configured outbound SIP and scheduled callback verification using controlled participant numbers. A local application does not remove carrier/trunk and network-reachability requirements for PSTN.
- A person can claim, acknowledge and resolve an actual follow-up case in the product. The queue can be internal initially, avoiding a mandatory external CRM/ticketing dependency for demonstrations.
- Local Langfuse plus operational telemetry storage, dashboards and alerts; a completed call can be traced across the worker/control plane, inspected in the ledger, and correlated with metrics and model decisions.
- Demonstrated recovery after restart, visible failed work, and retained cases/outcomes. Access control, destructive-route isolation, correct dates, stable loan identity and truthful outcomes belong in this milestone.

Lender-specific live synchronization, consent provenance, approved jurisdiction/disclosure policy and staffed operational agreements remain necessary before real debt collection. A real import/export workflow can be implemented locally with synthetic data; it must not be represented as a verified live lender integration.

## Clef conclusion

**Clef is a credible candidate for classifying completed borrower utterances and follow-up reasons. Evaluate it as a bounded decision component; do not make it a prerequisite for delivering the local product or a replacement for deterministic business controls.** This is an architectural recommendation, not a measured claim that Clef improves this repository.

Cloudflare's current endpoints expose `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`. They accept state plus typed questions and return answers keyed by question. REST access allows a Node container to call the service without moving the application onto Workers. Published input pricing is $0.24/million tokens for Clef and $0.09/million for Flash; verify actual billed usage when measuring. [Clef API](https://developers.cloudflare.com/workers-ai/models/clef/), [Flash API](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

The model card describes Clef as a 27B model scoring allowed options in one forward pass, with no free-form response generation; Flash is the smaller 9B variant. The released weights are Apache-2.0. Self-hosting is possible but is not necessary under the clarified scope, and its GPU capacity/performance has not been assessed here. [Cloudflare model card](https://huggingface.co/Cloudflare/clef), [Flash model page](https://developers.cloudflare.com/workers-ai/models/clef-flash/).

Cloudflare reports median/p95 benchmark latencies of 209.3/238.6 ms for Clef and 38.8/122.4 ms for Flash. Its results also show a substantial gap on CLINC150+OOS: 97.43 versus 66.77 macro-F1. These are vendor measurements on other tasks, not this app's network-inclusive latency or collections accuracy. Both variants merit comparison; Flash should not be selected solely because it is faster. [Announcement and benchmark tables](https://blog.cloudflare.com/clef-decision-models/).

The API's `choice` response includes the chosen option, per-option probabilities and confidence; `noul` returns a yes probability; `score` returns a weighted ordinal score. These values are model scores, not established correctness probabilities for this domain. Our client still needs to decode and validate the response and requested answer keys/options. [Published response schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json).

## Where it fits in this code

The current orchestrator first handles hold requests, then override rules, then the turn decider. The worker separately classifies brief backchannels while managing interruption/resume. These are distinct decision loops. Relevant sources: [Orchestrator](../../packages/control-plane/src/services/Orchestrator.ts), [overrides](../../packages/domain/src/overrides.ts), [hold requests](../../packages/domain/src/holdRequest.ts), [backchannels](../../packages/domain/src/backchannel.ts), [turn decider](../../packages/control-plane/src/services/TurnDecider.ts).

| Candidate use | Recommendation | Important boundary |
| --- | --- | --- |
| Follow-up reason and suggested queue | First candidate; can run outside the speech-critical path | Preserve explicit trigger/reason and allow staff correction; failure must not prevent case creation |
| Human request, callback request, end-call intent | Evaluate on finalized transcript plus recent context | Return semantic evidence; code chooses permitted action and truthful speech |
| Negated/ambiguous opt-out, dispute or hardship | Shadow first with strong per-class evaluation | Correct current rules first. A model cannot silently negate explicit protective signals |
| Acceptance/rejection of a pending proposal | Later candidate under strict state/context controls | Classifying “yes” never proves read-back completion or authorizes a different amount/date |
| Hold versus substantive response | Potential later evaluation | “Wait, I can pay Friday” must retain the offer rather than become silence |
| Interim backchannel, audio endpointing, VAD | Keep current local timing path initially | Clef's documented request is not raw live audio; network classification does not replace acoustic detection |
| Amount/date extraction or unrestricted speech | Keep existing extraction/generation and validators | Finite option scoring does not extract arbitrary new tool arguments or generate conversation |
| Consent, eligibility, tool legality, transaction ownership | Deterministic code | A classifier never grants permission to contact or bypasses persistence/playout checks |

The known callback-to-opt-out defect fires before the existing model. Adding Clef after `matchOverride` cannot fix it. Narrow the faulty rules, handle explicit stop signals promptly, and then use classification for the remaining semantic ambiguity. Do not preserve all current keyword hits as unquestionable truth.

## Proposed integration boundary

Keep the classifier as an I/O service in the control plane, with the provider implementation at the boundary. Keep its acceptance/routing policy pure in the domain. Do not introduce network I/O into `overrides.ts`, `holdRequest.ts` or the worker's immediate resume logic.

The classifier input should be a bounded snapshot: current state, finalized borrower utterance, last relevant agent question/heard text, a small recent context window, and the permitted pending-proposal context. Apply the same protected-context restrictions as the main decider; identifiers and unrelated borrower data are unnecessary.

Use separate protective questions where intents can coexist, plus a route choice with explicit `other`/`unclear` options. A single exclusive intent label loses information in “I cannot afford this; stop calling me.” Do not confuse `other` with abstention: the application must also abstain on uncertainty, conflicting outputs or insufficient context.

The normalized result should distinguish usable evidence, abstention, provider failure and stale/superseded results. Include provider/model, question-schema version, scores, duration and snapshot/turn identity. No model-generated explanation should be assumed: the published interface returns bounded answers rather than evidence prose.

Proposed behavior after evaluation:

1. Apply corrected deterministic safety rules and exact simple cases.
2. Classify eligible finalized utterances using a bounded deadline outside database transactions.
3. A pure policy accepts only approved routes using class-specific thresholds and context checks.
4. Accepted routes call the existing tool/state path and use approved speech templates where appropriate.
5. Unclear ordinary requests use the existing decider. Possible protective requests take the approved clarification/follow-up path; provider failure must not be interpreted as permission to continue collecting.
6. Recheck turn ownership/state at commit and discard late results. A classifier cannot commit directly or weaken the segment-level read-back guard.

Modes should be explicit: disabled, shadow, or enabled for a named subset of routes. In shadow mode, bounded background classification records predictions but cannot alter speech or business state. Avoid unbounded work or telemetry pressure in the voice path.

The [September 5 plan](../plans/2026-09-05-attribution-contract-instruments-and-self-hosted-turn-taking-spec.md) calls for a deterministic fast path with binary confidence. A probabilistic Clef branch is a deliberate extension to that plan, not completion of that exact requirement. Preserve source attribution such as deterministic-rule, classifier and main-model decisions in the eventual contract and dashboards.

## Evaluation before enabling decisions

Build a human-labeled set from existing scenarios, the reproduced defects and additional realistic utterances. Include negation, quotations, multiple intents, ASR errors, third parties, unusual requests, partial answers and corrections. Split by conversation/template family so near-duplicate paraphrases do not leak into the held-out evaluation. Synthetic examples bootstrap coverage; they do not establish real-borrower quality.

Compare corrected rules, the existing main decider, Clef and Flash on the same cases. Measure:

- Per-class precision/recall and false-positive/false-negative costs, especially stop requests, disputes and confirmation.
- Error rate among accepted automatic decisions versus the fraction accepted; calibration on held-out labels before assigning thresholds.
- End-to-end classifier p50/p95/p99 from the local Docker host, timeouts, malformed responses, concurrency, input length and usage.
- Total turn latency including fallbacks. Calling a classifier before every main-model request can make calls slower; savings require enough correctly resolved turns to avoid the larger request.
- State/tool correctness, preserved multi-intent signals, late-result handling and behavior during provider outage.

Start with asynchronous case labeling, then shadow conversational routing, then a narrowly enabled route set if it meets the agreed gates. Fine-tuning is deferred until measured failure patterns and sufficient labels justify it. The product must remain usable with the classifier disabled.

## Observability implications

The local milestone includes functioning observability, not just instrumentation imports or running dashboard containers. Preserve PostgreSQL as the business record and Langfuse for model/evaluation inspection. Add the local collection, storage, dashboards and alerting required for operational traces, metrics and logs. Exact backend packaging, retention and resource budgets belong in the implementation specification.

For classifier calls, record an OTel span correlated to the call/turn, model and question-schema identity, deadline, duration, scores, accepted route, abstention/fallback reason and eventual outcome. Keep input access/redaction consistent with the existing tracing policy. Use bounded labels for metrics; keep call IDs in traces/logs rather than metric labels. Show rule, classifier and main-model populations separately. Store raw scores separately from the code's accepted decision so later review can distinguish model errors from routing-policy errors.

A complete local demonstration should include: a real voice call that creates a follow-up case; a person claiming/resolving it; a successful scheduled callback; a durable outcome surviving restart; a trace explaining one decision; and an injected provider/job failure that appears in the dashboard and a local test alert receiver. These checks establish behavior, not merely container liveness.

## Evidence and remaining uncertainty

Primary sources were read on 2026-10-04, including the supplied announcement, both model pages, Cloudflare's model card and the raw API response schema. Context7 resolved the Workers AI documentation but its Clef query returned unrelated models; those snippets were not used as Clef evidence. Direct official pages supplied the relevant facts.

No Cloudflare model request was made, no benchmark was run, and no weights were downloaded. Collections accuracy, calibration, deployed latency, account access/rate limits and actual cost are unmeasured. The conclusion is suitability for a controlled evaluation. Selecting Clef or Flash for active routing requires that evidence.
