import { isVerdictScore } from "@feather-lite/domain";
import { api, type ConversationDetail, type ConversationSummary, type ScoreRow } from "../api.js";
import { badge, clear, fmtDur, fmtTime, h, pre, stateBadge } from "../dom.js";
import { renderWaterfall } from "./latency.js";

export const conversationsView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  const tbody = h("tbody");
  const count = h("span", { class: "muted small" }, "");
  root.append(
    h("h1", {}, "Conversations"),
    h("div", { class: "row", style: "margin-bottom:10px" }, h("button", { class: "btn", onClick: () => void load() }, "Refresh"), count),
    h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Borrower"), h("th", {}, "Outcome"), h("th", {}, "State"), h("th", {}, "Channel"), h("th", {}, "Started"), h("th", {}, "Duration"))), tbody)),
  );
  const load = async () => {
    try {
      const { items, total } = await api.conversations(100, 0);
      count.textContent = `${total} total`;
      clear(tbody);
      for (const c of items) tbody.append(row(c));
      if (items.length === 0) tbody.append(h("tr", {}, h("td", { colspan: "6", class: "muted" }, "No conversations yet — start one from Simulate or Call, or seed the demo data from Status.")));
    } catch (e) {
      clear(tbody);
      tbody.append(h("tr", {}, h("td", { colspan: "6", class: "err" }, `Failed to load: ${String(e)}`)));
    }
  };
  const row = (c: ConversationSummary) =>
    h(
      "tr",
      { class: "clickable", onClick: () => (location.hash = `#/conversations/${c.conversation_id}`) },
      h("td", {}, c.borrower_name, h("div", { class: "muted small mono" }, c.conversation_id.slice(0, 8))),
      h("td", {}, badge(c.final_outcome)),
      h("td", {}, stateBadge(c.current_state)),
      h("td", {}, c.channel),
      h("td", {}, fmtTime(c.started_at)),
      h("td", {}, fmtDur(c.duration_seconds)),
    );
  void load();
  const timer = setInterval(() => void load(), 5000);
  onStop(() => clearInterval(timer));
};

const EVENT_CLASS: Record<string, string> = {
  STATE_TRANSITION: "state",
  TOOL_CALLED: "tool",
  TOOL_RESULT: "tool",
  TOOL_REJECTED: "warn",
  TURN_DECISION_REJECTED: "warn",
  TURN_SUPERSEDED: "warn",
  CALL_CONTROL: "warn",
};

export const renderTranscript = (detail: ConversationDetail) =>
  h(
    "div",
    { class: "chat" },
    detail.transcript.length === 0 ? h("div", { class: "muted" }, "No turns yet.") : null,
    ...detail.transcript.map((t) =>
      h(
        "div",
        { class: `bubble ${t.speaker === "AGENT" ? "agent" : "borrower"} ${t.interrupted ? "interrupted" : ""}` },
        t.text,
        h("span", { class: "meta" }, `${t.speaker.toLowerCase()} · #${t.sequence_no}${t.interrupted ? " · interrupted (heard text)" : ""}`),
      ),
    ),
  );

export const renderTimeline = (detail: ConversationDetail) =>
  h(
    "div",
    { class: "timeline" },
    ...detail.event_timeline.map((e) =>
      h(
        "div",
        { class: "ev" },
        h("span", { class: "n" }, `#${e.sequence_no}`),
        h("span", { class: `t ${EVENT_CLASS[e.type] ?? ""}` }, e.type),
        h("span", { class: "p" }, summarizePayload(e.type, e.payload)),
      ),
    ),
  );

const summarizePayload = (type: string, p: Record<string, unknown>): string => {
  switch (type) {
    case "STATE_TRANSITION":
      return `${String(p["from"] ?? "∅")} → ${String(p["to"])}  (${String(p["triggered_by"])}${p["matched"] ? `: "${String(p["matched"])}"` : ""})`;
    case "AGENT_TURN":
      return `[${String(p["state"])}${p["speak_mode"] === "non_interruptible" ? ", NI" : ""}] ${String(p["text"])}`;
    case "USER_TURN_FINAL":
      return String(p["text"]);
    case "TOOL_CALLED":
      return `${String(p["name"])}(${JSON.stringify(p["args"])})`;
    case "TOOL_RESULT":
      return `${String(p["name"])} → ${JSON.stringify(p["result"])}`;
    case "TOOL_REJECTED":
      return `${String(p["name"])} in ${String(p["state"])}: ${String(p["reason"])} — ${String(p["detail"])}`;
    case "TURN_DECISION_REJECTED":
      return `${String(p["reason"])}: ${String(p["detail"])}`;
    case "AGENT_TURN_PLAYOUT":
      return `${p["interrupted"] ? "interrupted; heard: " : "played: "}"${String(p["heard_text"])}"`;
    case "CALL_CONTROL":
      return `${String(p["action"])} ${JSON.stringify({ ...p, action: undefined, action_id: undefined })}`;
    case "CALL_ENDED":
      return `final_outcome=${String(p["final_outcome"])}`;
    default:
      return JSON.stringify(p);
  }
};

const SOURCE_ORDER = ["HUMAN", "JUDGE", "EVALUATOR", "HARNESS", "SYSTEM", "SCENARIO"];


/**
 * The scores about this call, and the operator's own verdict.
 *
 * The human label is the calibration target for the judge — the Quality page's agreement number is
 * computed over calls that carry both — so recording one is the point of this control, not a
 * decoration. It posts through the same ingest route the voice harness uses.
 */
const renderScores = (id: string, rows: ScoreRow[], reload: () => void) => {
  const call = rows.filter((r) => r.turn_id === null).sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name));
  const perTurn = rows.filter((r) => r.turn_id !== null);
  const human = call.find((r) => r.name === "human.overall_pass");
  const note = h("input", { placeholder: "why (optional)", style: "min-width:200px" }) as HTMLInputElement;
  const out = h("span", { class: "small muted" });
  const label = async (pass: boolean) => {
    out.textContent = "saving…";
    try {
      await api.postScores(id, [{ name: "human.overall_pass", value: pass ? 1 : 0, source: "HUMAN", comment: note.value.trim() || null }]);
      out.textContent = "";
      reload();
    } catch (e) {
      out.textContent = "";
      out.append(h("span", { class: "err" }, (e as Error).message));
    }
  };
  const value = (r: ScoreRow) =>
    r.data_type !== "BOOLEAN"
      ? h("span", { class: "mono small" }, String(Math.round(r.value * 1000) / 1000))
      : isVerdictScore(r.name)
        ? badge(r.value === 1 ? "PASS" : "FAIL", r.value === 1 ? "good" : "bad")
        : badge(r.value === 1 ? "yes" : "no", "neutral");
  return h(
    "div",
    {},
    h(
      "div",
      { class: "row", style: "align-items:center;gap:8px;flex-wrap:wrap" },
      h("span", { class: "small muted" }, "Your verdict:"),
      h("button", { class: `btn ${human?.value === 1 ? "primary" : ""}`, onClick: () => void label(true) }, "Pass"),
      h("button", { class: `btn ${human?.value === 0 ? "danger" : ""}`, onClick: () => void label(false) }, "Fail"),
      note,
      out,
    ),
    // Said plainly: without human labels the agreement number on the Quality page is null, which is
    // the honest answer but not a useful one.
    human ? null : h("div", { class: "muted small", style: "margin-top:6px" }, "No human label yet. The judge cannot be calibrated against calls nobody looked at."),
    call.length === 0
      ? h("div", { class: "muted small", style: "margin-top:10px" }, "No scores yet. The evaluator and the judge run post-call from the outbox.")
      : h(
          "table",
          { style: "margin-top:10px" },
          h("thead", {}, h("tr", {}, h("th", {}, "score"), h("th", {}, "value"), h("th", {}, "source"), h("th", {}, "why"))),
          h(
            "tbody",
            {},
            ...call.map((r) =>
              h(
                "tr",
                {},
                h("td", { class: "mono small" }, r.name),
                h("td", {}, value(r)),
                h("td", { class: "small muted" }, r.source),
                // The judge's quote is what makes a verdict checkable in seconds; show it as a quote.
                h(
                  "td",
                  { class: "small" },
                  r.comment ?? "",
                  typeof r.evidence?.["quote"] === "string" && r.evidence["quote"] !== "" ? h("div", { class: "muted small", style: "margin-top:2px" }, `“${String(r.evidence["quote"])}”`) : null,
                ),
              ),
            ),
          ),
        ),
    // Per-turn scores are shown here rather than pointed at: the latency panel draws the turn's
    // waterfall and its speech shape, but a harness's per-turn word error rate is a score and has
    // nowhere else to appear. Grouped by turn, because "which turn was mis-transcribed" is the
    // question being asked.
    perTurn.length === 0
      ? null
      : h(
          "div",
          { style: "margin-top:12px" },
          h("h3", {}, "Per turn"),
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "turn"), h("th", {}, "score"), h("th", {}, "value"), h("th", {}, "source"))),
            h(
              "tbody",
              {},
              ...perTurn
                .slice()
                .sort((a, b) => (a.turn_id ?? "").localeCompare(b.turn_id ?? "") || a.name.localeCompare(b.name))
                .map((r) => h("tr", {}, h("td", { class: "mono small" }, r.turn_id ?? ""), h("td", { class: "mono small" }, r.name), h("td", {}, value(r)), h("td", { class: "small muted" }, r.source))),
            ),
          ),
        ),
  );
};

export const detailView = (root: HTMLElement, id: string, onStop: (fn: () => void) => void) => {
  clear(root);
  const head = h("div");
  const transcript = h("div", { class: "card" });
  const timeline = h("div", { class: "card" });
  const side = h("div", { class: "card" });
  const latency = h("div", { class: "card" });
  const scores = h("div", { class: "card" });
  root.append(
    h("div", { class: "row", style: "justify-content:space-between" }, h("h1", {}, "Conversation"), h("a", { href: "#/conversations" }, "← all conversations")),
    head,
    h(
      "div",
      { class: "grid2", style: "margin-top:12px" },
      h("div", {}, h("h2", {}, "Transcript"), transcript, h("h2", {}, "Quality scores"), scores, h("h2", {}, "Latency per turn"), latency, h("h2", {}, "Replay, actions & jobs"), side),
      h("div", {}, h("h2", {}, "Event timeline"), timeline),
    ),
  );
  let stopped = false;
  const load = async () => {
    try {
      const d = await api.conversation(id);
      const c = d.conversation;
      clear(head);
      head.append(
        h(
          "div",
          { class: "grid3" },
          h("div", { class: "card" }, h("h3", {}, "Outcome"), badge(c.final_outcome), h("div", { class: "small muted", style: "margin-top:6px" }, JSON.stringify(c.final_outcome_metadata))),
          h("div", { class: "card" }, h("h3", {}, "State"), stateBadge(c.current_state), h("div", { class: "small muted", style: "margin-top:6px" }, `protected context ${c.protected_context_unlocked ? "unlocked" : "locked"}${c.transfer_target ? ` · transfer → ${c.transfer_target}` : ""}`)),
          h("div", { class: "card" }, h("h3", {}, "Call"), h("dl", { class: "kv" }, h("dt", {}, "channel"), h("dd", {}, c.channel), h("dt", {}, "started"), h("dd", {}, fmtTime(c.started_at)), h("dt", {}, "ended"), h("dd", {}, fmtTime(c.ended_at)), h("dt", {}, "id"), h("dd", { class: "mono small" }, c.id))),
        ),
      );
      clear(transcript);
      transcript.append(renderTranscript(d));
      clear(timeline);
      timeline.append(renderTimeline(d));
      clear(latency);
      // Separate request: the waterfall reads conversation_turns, not the event ledger, and a
      // failure here must not blank the transcript next to it.
      latency.append(await api.turnLatencies(id).then(renderWaterfall, (e: unknown) => h("div", { class: "err small" }, `latency unavailable: ${String(e)}`)));
      clear(scores);
      // Its own request, like the waterfall: scores live in their own table, and a failure to read
      // them must not blank the transcript beside them.
      scores.append(await api.scores(id).then((rows) => renderScores(id, rows, () => void load()), (e: unknown) => h("div", { class: "err small" }, `scores unavailable: ${String(e)}`)));
      clear(side);
      side.append(
        h("h3", {}, "Replay from events"),
        pre(d.replay),
        h("h3", { style: "margin-top:12px" }, "Scheduled actions"),
        d.scheduled_actions.length ? pre(d.scheduled_actions) : h("div", { class: "muted small" }, "none"),
        h("h3", { style: "margin-top:12px" }, "Outbox jobs"),
        d.outbox_jobs.length ? pre(d.outbox_jobs.map((j) => ({ job_type: j["job_type"], status: j["status"], result: j["result"] }))) : h("div", { class: "muted small" }, "none"),
      );
      if (c.final_outcome !== null && !stopped) {
        // completed: slow refresh (outbox may still land)
        clearInterval(fast);
        setTimeout(() => void load(), 6000);
      }
    } catch (e) {
      clear(head);
      head.append(h("div", { class: "err" }, `Failed to load: ${String(e)}`));
    }
  };
  void load();
  const fast = setInterval(() => void load(), 2500);
  onStop(() => {
    stopped = true;
    clearInterval(fast);
  });
};
