/**
 * Simulate: the JSON path (PRD §5.2.4) with the streaming turn endpoint rendered live — deltas
 * appear as they arrive, `say` segments as distinct bubbles, and the timeline updates alongside.
 */
import { api, type Borrower, type ConversationDetail } from "../api.js";
import { badge, clear, h, stateBadge } from "../dom.js";
import { renderTimeline } from "./conversations.js";

export const borrowerPicker = (borrowers: Borrower[], onChange: (b: Borrower | null) => void) => {
  const select = h("select", { onChange: () => onChange(borrowers.find((b) => b.borrower_id === select.value) ?? null) });
  for (const b of borrowers) {
    const cp = b.contact_points[0];
    const blocked = b.status !== "ACTIVE" || !cp || !cp.is_valid || cp.consent_status === "OPTED_OUT" || !b.within_contact_window;
    const why = b.status !== "ACTIVE" ? b.status : !cp ? "no contact point" : !cp.is_valid ? "invalid number" : cp.consent_status === "OPTED_OUT" ? "opted out" : !b.within_contact_window ? "outside contact window" : "";
    select.append(h("option", { value: b.borrower_id }, `${b.name} — ${b.timezone}${b.loan ? ` — ${b.loan.balance_due} due ${b.loan.due_date}` : ""}${blocked ? ` (${why}: expect 422)` : ""}`));
  }
  return select;
};

export const simulateView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  let borrowers: Borrower[] = [];
  let current: Borrower | null = null;
  let conversationId: string | null = null;
  let turnNo = 0;
  let ended = false;

  const pickerHost = h("div");
  const startBtn = h("button", { class: "btn primary", onClick: () => void start() }, "Start simulated call");
  const status = h("div", { class: "muted small" });
  const chat = h("div", { class: "chat" });
  const input = h("input", { placeholder: "Type what the borrower says…", style: "flex:1", onKeydown: (e) => { if ((e as KeyboardEvent).key === "Enter") void send(); } });
  const sendBtn = h("button", { class: "btn primary", onClick: () => void send() }, "Send");
  const noInputBtn = h("button", { class: "btn", onClick: () => void signal("no_input") }, "No input");
  const hangupBtn = h("button", { class: "btn danger", onClick: () => void signal("hangup") }, "Hang up");
  const timeline = h("div", { class: "card" });
  const stateLine = h("div", { class: "row small" });

  root.append(
    h("h1", {}, "Simulate a call (JSON path)"),
    h("div", { class: "card row" }, pickerHost, startBtn, status),
    h(
      "div",
      { class: "grid2", style: "margin-top:12px" },
      h("div", {}, h("h2", {}, "Conversation"), h("div", { class: "card" }, chat, h("div", { class: "row", style: "margin-top:10px" }, input, sendBtn, noInputBtn, hangupBtn), stateLine)),
      h("div", {}, h("h2", {}, "Event timeline (live)"), timeline),
    ),
  );

  const setEnabled = (on: boolean) => {
    for (const el of [input, sendBtn, noInputBtn, hangupBtn]) (el as HTMLButtonElement | HTMLInputElement).disabled = !on;
  };
  setEnabled(false);

  const refreshTimeline = async () => {
    if (!conversationId) return;
    try {
      const d: ConversationDetail = await api.conversation(conversationId);
      clear(timeline);
      timeline.append(renderTimeline(d));
      clear(stateLine);
      stateLine.append("state ", stateBadge(d.conversation.current_state), " outcome ", badge(d.conversation.final_outcome), h("span", { class: "muted" }, ` · protected ${d.conversation.protected_context_unlocked ? "unlocked" : "locked"}`));
    } catch {
      /* ignore */
    }
  };

  const bubble = (who: "agent" | "borrower", text: string, extra = "") => {
    const b = h("div", { class: `bubble ${who} ${extra}` }, text);
    chat.append(b);
    b.scrollIntoView({ block: "end" });
    return b;
  };

  const start = async () => {
    if (!current) return;
    const cp = current.contact_points[0];
    if (!cp) return;
    clear(chat);
    ended = false;
    turnNo = 0;
    status.textContent = "starting…";
    try {
      const r = await api.startCall(current.borrower_id, cp.contact_point_id);
      conversationId = r.conversation_id;
      status.textContent = `conversation ${r.conversation_id.slice(0, 8)} · `;
      status.append(h("a", { href: `#/conversations/${r.conversation_id}` }, "open"));
      bubble("agent", r.opening_text, "say ni");
      setEnabled(true);
      input.focus();
      await refreshTimeline();
    } catch (e) {
      status.textContent = "";
      status.append(h("span", { class: "err" }, `Rejected: ${(e as Error).message}`));
    }
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text || !conversationId || ended) return;
    input.value = "";
    bubble("borrower", text);
    turnNo += 1;
    const turnId = `console-${Date.now().toString(36)}-${turnNo}`;
    let live: HTMLElement | null = null;
    setEnabled(false);
    try {
      for await (const f of api.turn(conversationId, turnId, text)) {
        if (f.type === "delta") {
          if (!live) {
            live = bubble("agent", "", "stream-cursor");
          }
          live.textContent += f.text;
        } else if (f.type === "say") {
          if (live) live.classList.remove("stream-cursor");
          live = null;
          bubble("agent", f.text, `say ${f.allow_interruptions ? "" : "ni"}`);
        } else if (f.type === "turn_end") {
          if (live) live.classList.remove("stream-cursor");
          const meta = h("div", { class: "muted small" }, `→ ${f.new_state}${f.tool_called ? ` · tool ${f.tool_called.name}(${JSON.stringify(f.tool_called.args)})` : ""}${f.outcome ? ` · outcome ${f.outcome}` : ""}${f.degraded ? " · degraded" : ""}${f.ttft_ms !== null ? ` · ttft ${f.ttft_ms}ms` : ""}`);
          chat.append(meta);
          if (f.end_call) ended = true;
        } else if (f.type === "error") {
          chat.append(h("div", { class: "err small" }, `${f.code}: ${f.message}`));
        }
      }
    } catch (e) {
      chat.append(h("div", { class: "err small" }, (e as Error).message));
    } finally {
      setEnabled(!ended);
      await refreshTimeline();
    }
  };

  const signal = async (kind: "no_input" | "hangup") => {
    if (!conversationId || ended) return;
    try {
      const r = kind === "no_input" ? await api.noInput(conversationId) : await api.signal(conversationId, { kind: "hangup", reason: "console" });
      if (r.agent_text) bubble("agent", r.agent_text, "say");
      if (r.end_call) {
        ended = true;
        setEnabled(false);
      }
      await refreshTimeline();
    } catch (e) {
      chat.append(h("div", { class: "err small" }, (e as Error).message));
    }
  };

  void (async () => {
    try {
      borrowers = await api.borrowers();
      current = borrowers.find((b) => b.status === "ACTIVE" && b.within_contact_window && b.contact_points[0]?.is_valid) ?? borrowers[0] ?? null;
      const picker = borrowerPicker(borrowers, (b) => (current = b));
      if (current) picker.value = current.borrower_id;
      pickerHost.append(picker);
    } catch (e) {
      pickerHost.append(h("span", { class: "err" }, `Cannot load borrowers: ${(e as Error).message}`));
    }
  })();
  onStop(() => undefined);
};
