/**
 * Call: "Call me in the browser" — POST /api/voice/sessions, join the LiveKit room with the mic,
 * play the agent's audio, show live transcripts (agent + borrower) from the `lk.transcription`
 * text stream, and poll the ledger timeline beside it.
 */
import type { RemoteTrack, Room, TextStreamReader } from "livekit-client";
import { api, type Borrower, type ConversationDetail } from "../api.js";
import { badge, clear, h, stateBadge } from "../dom.js";
import { renderTimeline } from "./conversations.js";
import { borrowerPicker } from "./simulate.js";

export const callView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  let borrowers: Borrower[] = [];
  let current: Borrower | null = null;
  let room: Room | null = null;
  let conversationId: string | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const pickerHost = h("div");
  const workerLine = h("div", { class: "small" });
  const callBtn = h("button", { class: "btn primary", onClick: () => void call("browser") }, "Call me in the browser");
  const sipBtn = h("button", { class: "btn", onClick: () => void call("sip") }, "Dial my phone (SIP)");
  const hangBtn = h("button", { class: "btn danger", disabled: true, onClick: () => void hangup() }, "Hang up");
  const status = h("div", { class: "muted small" });
  const chat = h("div", { class: "chat" });
  const timeline = h("div", { class: "card" });
  const stateLine = h("div", { class: "row small" });
  const audioHost = h("div");

  root.append(
    h("h1", {}, "Live call"),
    h("div", { class: "card" }, h("div", { class: "row" }, pickerHost, callBtn, sipBtn, hangBtn), workerLine, status),
    h(
      "div",
      { class: "grid2", style: "margin-top:12px" },
      h("div", {}, h("h2", {}, "Live transcript"), h("div", { class: "card" }, chat, stateLine)),
      h("div", {}, h("h2", {}, "Ledger timeline (polling)"), timeline),
    ),
    audioHost,
  );

  const bubble = (who: "agent" | "borrower", text: string) => {
    const b = h("div", { class: `bubble ${who}` }, text);
    chat.append(b);
    b.scrollIntoView({ block: "end" });
    return b;
  };

  const refresh = async () => {
    if (!conversationId) return;
    try {
      const d: ConversationDetail = await api.conversation(conversationId);
      clear(timeline);
      timeline.append(renderTimeline(d));
      clear(stateLine);
      stateLine.append("state ", stateBadge(d.conversation.current_state), " outcome ", badge(d.conversation.final_outcome), " ", h("a", { href: `#/conversations/${conversationId}` }, "open"));
      if (d.conversation.final_outcome && poll) {
        clearInterval(poll);
        poll = null;
      }
    } catch {
      /* ignore */
    }
  };

  const checkWorker = async () => {
    try {
      const s = await api.status();
      const online = s.agents.some((a) => a.online);
      clear(workerLine);
      workerLine.append(h("span", { class: `dot ${online ? "on" : "off"}` }), online ? `agent worker online (${s.agents.filter((a) => a.online).map((a) => a.agent_name).join(", ")})` : "no agent worker online — start apps/voice-worker; the call will ring with nobody home");
    } catch {
      /* ignore */
    }
  };

  const call = async (mode: "browser" | "sip") => {
    if (!current) return;
    const cp = current.contact_points[0];
    if (!cp) return;
    clear(chat);
    status.textContent = "creating session…";
    callBtn.disabled = true;
    sipBtn.disabled = true;
    try {
      const s = await api.voiceSession(current.borrower_id, cp.contact_point_id, mode);
      conversationId = s.conversation_id;
      status.textContent = `room ${s.room_name} · conversation ${s.conversation_id.slice(0, 8)}`;
      const { Room, RoomEvent, Track } = await import("livekit-client"); // lazy: only the call page pays for the WebRTC SDK
      room = new Room({ adaptiveStream: true, dynacast: false });
      const live = new Map<string, HTMLElement>(); // segment id -> bubble
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.autoplay = true;
          audioHost.append(el);
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        status.textContent += " · disconnected";
        hangBtn.disabled = true;
        callBtn.disabled = false;
        sipBtn.disabled = false;
        void refresh();
      });
      room.registerTextStreamHandler("lk.transcription", async (reader: TextStreamReader, participant) => {
        const attrs = reader.info.attributes ?? {};
        const isAgent = (participant?.identity ?? "").startsWith("agent");
        const segId = attrs["lk.segment_id"] ?? reader.info.id;
        let el = live.get(segId);
        for await (const chunk of reader) {
          if (!el) {
            el = bubble(isAgent ? "agent" : "borrower", "");
            live.set(segId, el);
          }
          if (attrs["lk.transcription_final"] === "true" && !isAgent) el.textContent = chunk;
          else el.textContent += chunk;
        }
      });
      await room.connect(s.livekit_url, s.participant_token);
      if (mode === "browser") await room.localParticipant.setMicrophoneEnabled(true);
      hangBtn.disabled = false;
      poll = setInterval(() => void refresh(), 2000);
      void refresh();
    } catch (e) {
      status.textContent = "";
      status.append(h("span", { class: "err" }, `Failed: ${(e as Error).message}`));
      callBtn.disabled = false;
      sipBtn.disabled = false;
    }
  };

  const hangup = async () => {
    if (room) await room.disconnect();
    room = null;
    hangBtn.disabled = true;
    callBtn.disabled = false;
    sipBtn.disabled = false;
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
    await checkWorker();
  })();
  const workerTimer = setInterval(() => void checkWorker(), 10_000);
  onStop(() => {
    clearInterval(workerTimer);
    if (poll) clearInterval(poll);
    void hangup();
  });
};
