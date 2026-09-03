import type { SqlClient } from "@effect/sql";

/**
 * SQL twin of the domain's `silentPlayoutTurnIds`: a playout that was cut short with nothing heard,
 * excluding turns the borrower superseded before the agent replied (same shape, not a TTS failure).
 * Column references only; never interpolate user data here.
 */
export const silentPlayoutSql = (sql: SqlClient.SqlClient) => ({
  unheardPlayout: (events: string) =>
    sql.unsafe(`${events}.type = 'AGENT_TURN_PLAYOUT' AND ${events}.payload->>'interrupted' = 'true' AND ${events}.payload->>'heard_text' = ''`),
  notSuperseded: (conversationId: string, turnId: string) =>
    sql.unsafe(
      `NOT EXISTS (SELECT 1 FROM conversation_events s WHERE s.conversation_id = ${conversationId} AND s.type = 'TURN_SUPERSEDED' AND s.payload->>'turn_id' = ${turnId})`,
    ),
});
