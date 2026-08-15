import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_STATES,
  EMPTY_MEMORY,
  POLICY,
  PROTECTED_FIELD_NAMES,
  buildMemoryBlock,
  evaluatePreCall,
  isWithinContactWindow,
  localIsoDate,
  nextLocalHour,
  splitSentences,
  visibleContext,
  type PreCallInput,
} from "../src/index.js";
import { miniMiranda, promiseReadback, voicemailScript } from "../src/scripts.js";

const utc = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso);

const okInput = (now: DateTime.Utc, tz = "America/New_York"): PreCallInput => ({
  now,
  borrower: { status: "ACTIVE", timezone: tz },
  contactPoint: { isValid: true, consentStatus: "ALLOWED", timezoneOverride: null, linkedToBorrower: true },
  recentAttemptCount: 0,
  hasActiveConversation: false,
  conflictingPendingActions: 0,
});

describe("TCPA contact window — boundaries in borrower-local time (plan rev.2 R13)", () => {
  // 2026-08-16 is EDT (UTC-4). 07:59 local = 11:59Z; 08:00 = 12:00Z; 20:59 = 00:59Z next day; 21:00 = 01:00Z.
  it.each([
    ["2026-08-16T11:59:00Z", false, "07:59 EDT"],
    ["2026-08-16T12:00:00Z", true, "08:00 EDT"],
    ["2026-08-17T00:59:00Z", true, "20:59 EDT"],
    ["2026-08-17T01:00:00Z", false, "21:00 EDT"],
  ])("%s -> within=%s (%s)", (iso, expected) => {
    expect(Option.getOrThrow(isWithinContactWindow(utc(iso), "America/New_York"))).toBe(expected);
  });

  it("uses standard time on either side of the US spring-forward day (2026-03-08)", () => {
    // 07:59 EST on Mar 7 = 12:59Z (UTC-5); after DST, 07:59 EDT on Mar 9 = 11:59Z (UTC-4).
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-03-07T12:59:00Z"), "America/New_York"))).toBe(false);
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-03-07T13:00:00Z"), "America/New_York"))).toBe(true);
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-03-09T11:59:00Z"), "America/New_York"))).toBe(false);
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-03-09T12:00:00Z"), "America/New_York"))).toBe(true);
  });

  it("IST has no DST: 08:00 IST = 02:30Z, 21:00 IST = 15:30Z", () => {
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-08-16T02:29:00Z"), "Asia/Kolkata"))).toBe(false);
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-08-16T02:30:00Z"), "Asia/Kolkata"))).toBe(true);
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-08-16T15:29:00Z"), "Asia/Kolkata"))).toBe(true);
    expect(Option.getOrThrow(isWithinContactWindow(utc("2026-08-16T15:30:00Z"), "Asia/Kolkata"))).toBe(false);
  });

  it("unknown zone is a failure, not a pass", () => {
    expect(Option.isNone(isWithinContactWindow(utc("2026-08-16T12:00:00Z"), "Mars/Olympus"))).toBe(true);
    expect(evaluatePreCall(okInput(utc("2026-08-16T12:00:00Z"), "Mars/Olympus"))).toContain("UNKNOWN_TIMEZONE");
  });
});

describe("evaluatePreCall — all six checks, all reported at once", () => {
  const noon = utc("2026-08-16T16:00:00Z"); // 12:00 EDT

  it("passes a clean input", () => {
    expect(evaluatePreCall(okInput(noon))).toEqual([]);
  });

  it("reports every failure, not just the first", () => {
    const failures = evaluatePreCall({
      now: utc("2026-08-16T02:00:00Z"), // 22:00 EDT
      borrower: { status: "OPT_OUT", timezone: "America/New_York" },
      contactPoint: { isValid: false, consentStatus: "OPTED_OUT", timezoneOverride: null, linkedToBorrower: false },
      recentAttemptCount: POLICY.frequencyCapAttempts,
      hasActiveConversation: true,
      conflictingPendingActions: 2,
    });
    expect([...failures].sort()).toEqual(
      [
        "ACTIVE_CONVERSATION",
        "BORROWER_OPT_OUT",
        "CONTACT_POINT_INVALID_OR_OPTED_OUT",
        "CONTACT_POINT_NOT_ASSOCIATED",
        "FREQUENCY_CAP",
        "SCHEDULED_ACTION_CONFLICT",
        "TCPA_TIME_WINDOW",
      ].sort(),
    );
  });

  it("frequency cap: 6 recent attempts pass, 7 fail (Reg F 7-in-7)", () => {
    expect(evaluatePreCall({ ...okInput(noon), recentAttemptCount: 6 })).toEqual([]);
    expect(evaluatePreCall({ ...okInput(noon), recentAttemptCount: 7 })).toEqual(["FREQUENCY_CAP"]);
  });

  it("contact-point timezone override wins over the borrower's timezone", () => {
    // 12:00Z: 08:00 EDT (in window) but 17:30 IST (in window) — use 02:00Z: 22:00 EDT (out) vs 07:30 IST (out) vs 09:00 in Asia/Dubai (in)
    const input = { ...okInput(utc("2026-08-16T05:00:00Z")), contactPoint: { ...okInput(noon).contactPoint, timezoneOverride: "Asia/Dubai" } };
    expect(evaluatePreCall(input)).toEqual([]); // 09:00 Dubai
    expect(evaluatePreCall(okInput(utc("2026-08-16T05:00:00Z")))).toEqual(["TCPA_TIME_WINDOW"]); // 01:00 EDT
  });
});

describe("nextLocalHour — reschedule to the next 08:00 local", () => {
  it("moves a 22:00 EDT action to 08:00 EDT next day", () => {
    const next = nextLocalHour(utc("2026-08-17T02:00:00Z"), "America/New_York", 8); // 22:00 EDT Aug 16
    expect(DateTime.formatIso(next)).toBe("2026-08-17T12:00:00.000Z"); // 08:00 EDT Aug 17
  });
  it("keeps today's 08:00 if it is still ahead", () => {
    const next = nextLocalHour(utc("2026-08-16T09:00:00Z"), "America/New_York", 8); // 05:00 EDT
    expect(DateTime.formatIso(next)).toBe("2026-08-16T12:00:00.000Z");
  });
  it("crosses the US fall-back day correctly (2026-11-01)", () => {
    // 22:00 EDT on Oct 31 = 02:00Z Nov 1; next 08:00 local is EST (UTC-5) = 13:00Z.
    const next = nextLocalHour(utc("2026-11-01T02:00:00Z"), "America/New_York", 8);
    expect(DateTime.formatIso(next)).toBe("2026-11-01T13:00:00.000Z");
  });
  it("gives the borrower's local calendar date", () => {
    expect(Option.getOrThrow(localIsoDate(utc("2026-08-16T02:00:00Z"), "America/New_York"))).toBe("2026-08-15");
    expect(Option.getOrThrow(localIsoDate(utc("2026-08-16T02:00:00Z"), "Asia/Kolkata"))).toBe("2026-08-16");
  });
});

describe("visibleContext — the right-party gate, over every state", () => {
  const bundle = {
    publicContext: {
      agent_name: "Ava",
      company: "Feather-Lite Collections",
      callback_number: "+18005550100",
      workflow_type: "PAYMENT_REMINDER",
      attempt_no: 1,
      local_time_description: "Sunday 2:05 PM",
      borrower_first_name: "Jordan",
    },
    protectedContext: {
      borrower_full_name: "Jordan Avery",
      balance_due: "550.00",
      due_date: "2026-08-01",
      loan_status: "DELINQUENT",
      delinquency_days: 15,
      last_promise_date: null,
    },
    memory: { ...EMPTY_MEMORY, recent_outcomes: ["NO_ANSWER"], prior_conversation_count: 1 },
  };

  it("never exposes protected data before unlock, in any state", () => {
    for (const s of CONVERSATION_STATES) {
      const v = visibleContext(bundle, s, false);
      expect(v.protectedContext, s).toBeNull();
      expect(v.memory, s).toBeNull();
      const serialized = JSON.stringify(v);
      for (const f of PROTECTED_FIELD_NAMES) {
        const value = bundle.protectedContext[f];
        if (value !== null) expect(serialized, `${s} leaks ${f}`).not.toContain(String(value));
      }
    }
  });

  it("after unlock, exposes protected data only in DISCUSSING_PAYMENT / CONFIRMING_OUTCOME", () => {
    for (const s of CONVERSATION_STATES) {
      const v = visibleContext(bundle, s, true);
      const expected = s === "DISCUSSING_PAYMENT" || s === "CONFIRMING_OUTCOME";
      expect(v.protectedContext !== null, s).toBe(expected);
    }
  });

  it("builds a compact memory block from prior conversations", () => {
    const m = buildMemoryBlock([
      { final_outcome: "NO_ANSWER", ended_at: "2026-08-10T10:00:00Z", protected_context_unlocked: false, final_outcome_metadata: {} },
      { final_outcome: "PROMISE_TO_PAY", ended_at: "2026-08-01T10:00:00Z", protected_context_unlocked: true, final_outcome_metadata: { promised_amount: "500.00", promised_date: "2026-08-05" } },
      { final_outcome: "CALLBACK_SCHEDULED", ended_at: "2026-07-20T10:00:00Z", protected_context_unlocked: true, final_outcome_metadata: { callback_at: "2026-07-21T15:00:00Z" } },
    ]);
    expect(m.recent_outcomes).toEqual(["NO_ANSWER", "PROMISE_TO_PAY", "CALLBACK_SCHEDULED"]);
    expect(m.last_promise_to_pay).toEqual({ amount: "500.00", date: "2026-08-05" });
    expect(m.last_callback_requested_at).toBe("2026-07-21T15:00:00Z");
    expect(m.last_right_party_contact_at).toBe("2026-08-01T10:00:00Z");
    expect(m.prior_conversation_count).toBe(3);
  });
});

describe("scripts", () => {
  it("Mini-Miranda is verbatim FDCPA §1692e(11) language", () => {
    expect(miniMiranda({ agent_name: "Ava", company: "Feather-Lite Collections" })).toBe(
      "This is Ava calling from Feather-Lite Collections. This is an attempt to collect a debt, and any information obtained will be used for that purpose.",
    );
  });
  it("voicemail never contains an amount, a date, or the word debt", () => {
    const vm = voicemailScript({ agent_name: "Ava", company: "Feather-Lite Collections", callback_number: "+1 800 555 0100" });
    expect(vm).not.toMatch(/debt|balance|owe|\$|\d{4}-\d{2}-\d{2}/i);
  });
  it("read-back speaks the exact amount and calendar date", () => {
    expect(promiseReadback({ amount: "1200.50", date: "2026-08-21" })).toBe(
      "To confirm: you will pay 1,200 dollars and 50 cents by Friday, August 21, 2026. Is that correct? Please say yes to confirm.",
    );
  });
});

describe("splitSentences (LLM -> TTS chunking)", () => {
  it("emits complete sentences and keeps the remainder", () => {
    expect(splitSentences("Hello there. Your balance is 550.00 dollars. Can you")).toEqual([
      ["Hello there.", "Your balance is 550.00 dollars."],
      "Can you",
    ]);
  });
  it("does not split inside a decimal amount", () => {
    expect(splitSentences("You owe 550.00 by Friday")).toEqual([[], "You owe 550.00 by Friday"]);
  });
});
