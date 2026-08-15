/**
 * Pre-call validation policy (PRD §5.2.8, SPEC §12.1). Pure: the caller
 * gathers the facts (counts, flags, `now`) and this decides.
 *
 * All checks run; the full list of failures is returned so the API can report
 * every reason at once (`422 { validation_failures: [...] }`).
 */
import type { DateTime } from "effect";
import { Option, Schema } from "effect";
import type { BorrowerStatus, ConsentStatus } from "./enums.js";
import { localParts } from "./time.js";

export const PreCallFailure = Schema.Literal(
  "BORROWER_OPT_OUT",
  "BORROWER_DECEASED",
  "CONTACT_POINT_INVALID_OR_OPTED_OUT",
  "CONTACT_POINT_NOT_ASSOCIATED",
  "TCPA_TIME_WINDOW",
  "FREQUENCY_CAP",
  "ACTIVE_CONVERSATION",
  "SCHEDULED_ACTION_CONFLICT",
  "UNKNOWN_TIMEZONE",
);
export type PreCallFailure = typeof PreCallFailure.Type;

/** Regulatory / policy constants. Named so they can be cited in the console and tests. */
export const POLICY = {
  /** TCPA / FDCPA §1692c(a)(1): contact only between 8:00 and 21:00 local time. */
  contactWindowStartHour: 8,
  contactWindowEndHour: 21, // exclusive
  /** CFPB Reg F 7-in-7 presumption: no more than 7 call attempts in 7 consecutive days. */
  frequencyCapAttempts: 7,
  frequencyCapWindowDays: 7,
  /** Retry after NO_ANSWER / no-input. */
  retryDelayHours: 4,
  /** Consecutive NO_INPUT events before the attempt is closed. */
  noInputStrikes: 2,
} as const;

export interface PreCallInput {
  readonly now: DateTime.Utc;
  readonly borrower: {
    readonly status: BorrowerStatus;
    readonly timezone: string;
  };
  readonly contactPoint: {
    readonly isValid: boolean;
    readonly consentStatus: ConsentStatus;
    readonly timezoneOverride: string | null;
    /** Whether the contact point is linked to this borrower. */
    readonly linkedToBorrower: boolean;
  };
  /** Call attempts to this borrower+contact point in the last `frequencyCapWindowDays`. */
  readonly recentAttemptCount: number;
  readonly hasActiveConversation: boolean;
  /** Pending CALLBACK / RETRY_CALL actions for this borrower that would conflict. */
  readonly conflictingPendingActions: number;
}

export const isWithinContactWindow = (now: DateTime.Utc, timeZone: string): Option.Option<boolean> =>
  localParts(now, timeZone).pipe(
    Option.map((p) => p.hours >= POLICY.contactWindowStartHour && p.hours < POLICY.contactWindowEndHour),
  );

export const evaluatePreCall = (input: PreCallInput): ReadonlyArray<PreCallFailure> => {
  const failures: PreCallFailure[] = [];

  if (input.borrower.status === "OPT_OUT") failures.push("BORROWER_OPT_OUT");
  if (input.borrower.status === "DECEASED") failures.push("BORROWER_DECEASED");

  if (!input.contactPoint.linkedToBorrower) failures.push("CONTACT_POINT_NOT_ASSOCIATED");
  if (input.contactPoint.consentStatus === "OPTED_OUT" || !input.contactPoint.isValid) {
    failures.push("CONTACT_POINT_INVALID_OR_OPTED_OUT");
  }

  const tz = input.contactPoint.timezoneOverride ?? input.borrower.timezone;
  Option.match(isWithinContactWindow(input.now, tz), {
    onNone: () => failures.push("UNKNOWN_TIMEZONE"),
    onSome: (ok) => {
      if (!ok) failures.push("TCPA_TIME_WINDOW");
    },
  });

  if (input.recentAttemptCount >= POLICY.frequencyCapAttempts) failures.push("FREQUENCY_CAP");
  if (input.hasActiveConversation) failures.push("ACTIVE_CONVERSATION");
  if (input.conflictingPendingActions > 0) failures.push("SCHEDULED_ACTION_CONFLICT");

  return failures;
};
