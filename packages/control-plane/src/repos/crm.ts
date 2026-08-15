/**
 * CRM-side repository: borrowers, contact points, loans, agent versions.
 */
import { Effect, Option, Schema } from "effect";
import { SqlSchema } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import type { BorrowerStatus, ConsentStatus } from "@feather-lite/domain";
import { AgentVersionRow, BorrowerContactLinkRow, BorrowerRow, ContactPointRow, LoanRow } from "../db/rows.js";

const BORROWER_COLS = "id, name, preferred_language, timezone, status, created_at, updated_at";
const CONTACT_COLS = "id, type, value, is_valid, consent_status, timezone_override";
const LOAN_COLS =
  "id, borrower_id, principal::text AS principal, balance_due::text AS balance_due, due_date::text AS due_date, status, delinquency_days, last_promise_date::text AS last_promise_date";

export class CrmRepo extends Effect.Service<CrmRepo>()("@feather-lite/CrmRepo", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const findBorrower = SqlSchema.findOne({
      Request: Schema.String,
      Result: BorrowerRow,
      execute: (id) => sql`SELECT ${sql.unsafe(BORROWER_COLS)} FROM borrowers WHERE id = ${id}`,
    });

    /** Row lock for the duration of the transaction (serialises call starts per borrower). */
    const lockBorrower = SqlSchema.findOne({
      Request: Schema.String,
      Result: BorrowerRow,
      execute: (id) => sql`SELECT ${sql.unsafe(BORROWER_COLS)} FROM borrowers WHERE id = ${id} FOR UPDATE`,
    });

    const listBorrowers = SqlSchema.findAll({
      Request: Schema.Void,
      Result: BorrowerRow,
      execute: () => sql`SELECT ${sql.unsafe(BORROWER_COLS)} FROM borrowers ORDER BY name`,
    });

    const findContactPoint = SqlSchema.findOne({
      Request: Schema.String,
      Result: ContactPointRow,
      execute: (id) => sql`SELECT ${sql.unsafe(CONTACT_COLS)} FROM contact_points WHERE id = ${id}`,
    });

    const contactPointsForBorrower = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.extend(ContactPointRow, Schema.Struct({ priority: Schema.Number, relationship: Schema.String })),
      execute: (borrowerId) => sql`
        SELECT cp.id, cp.type, cp.value, cp.is_valid, cp.consent_status, cp.timezone_override, l.priority, l.relationship
        FROM borrower_contact_points l JOIN contact_points cp ON cp.id = l.contact_point_id
        WHERE l.borrower_id = ${borrowerId} ORDER BY l.priority`,
    });

    const findLink = SqlSchema.findOne({
      Request: Schema.Struct({ borrowerId: Schema.String, contactPointId: Schema.String }),
      Result: BorrowerContactLinkRow,
      execute: ({ borrowerId, contactPointId }) => sql`
        SELECT borrower_id, contact_point_id, priority, relationship FROM borrower_contact_points
        WHERE borrower_id = ${borrowerId} AND contact_point_id = ${contactPointId}`,
    });

    /** The loan to discuss: most delinquent first, then earliest due. One loan per borrower in the demo. */
    const primaryLoanForBorrower = SqlSchema.findOne({
      Request: Schema.String,
      Result: LoanRow,
      execute: (borrowerId) => sql`
        SELECT ${sql.unsafe(LOAN_COLS)} FROM loans WHERE borrower_id = ${borrowerId}
        ORDER BY delinquency_days DESC, due_date ASC, id ASC LIMIT 1`,
    });

    const setBorrowerStatus = (id: string, status: BorrowerStatus) =>
      sql`UPDATE borrowers SET status = ${status}, updated_at = now() WHERE id = ${id}`.pipe(Effect.asVoid);

    const setContactPointConsent = (id: string, consent: ConsentStatus) =>
      sql`UPDATE contact_points SET consent_status = ${consent}, updated_at = now() WHERE id = ${id}`.pipe(Effect.asVoid);

    const setContactPointValidity = (id: string, isValid: boolean) =>
      sql`UPDATE contact_points SET is_valid = ${isValid}, updated_at = now() WHERE id = ${id}`.pipe(Effect.asVoid);

    const setLoanLastPromiseDate = (loanId: string, isoDate: string) =>
      sql`UPDATE loans SET last_promise_date = ${isoDate}::date WHERE id = ${loanId}`.pipe(Effect.asVoid);

    const findActiveAgentVersion = SqlSchema.findOne({
      Request: Schema.Void,
      Result: AgentVersionRow,
      execute: () => sql`SELECT id, name, prompt_hash, status FROM agent_versions WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
    });

    /** Ensures one ACTIVE agent version exists (bootstrap) and returns it. */
    const ensureActiveAgentVersion = (id: string, name: string, promptHash: string) =>
      Effect.gen(function* () {
        const existing = yield* findActiveAgentVersion();
        if (Option.isSome(existing)) return existing.value;
        yield* sql`INSERT INTO agent_versions ${sql.insert({ id, name, promptHash, status: "ACTIVE" })}`;
        return { id, name, promptHash, status: "ACTIVE" as const };
      });

    return {
      findBorrower,
      lockBorrower,
      listBorrowers,
      findContactPoint,
      contactPointsForBorrower,
      findLink,
      primaryLoanForBorrower,
      setBorrowerStatus,
      setContactPointConsent,
      setContactPointValidity,
      setLoanLastPromiseDate,
      findActiveAgentVersion,
      ensureActiveAgentVersion,
    } as const;
  }),
}) {}
