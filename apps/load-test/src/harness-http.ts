/**
 * The headers every harness sends to the control plane, in one place (O9).
 *
 * There were six copies of `{"content-type", authorization}` across the two harness packages, which
 * was fine while there was one header to get right. There are now two: a load run drives hundreds
 * of turns a minute from one address, and the server's own per-IP budget sheds it — a tier-1 run
 * was 429ed 92 times and reported "23/50 correct", with the failure looking exactly like the agent
 * being broken.
 *
 * The previous answer was to raise `RATE_LIMIT_PER_MINUTE` and `DAILY_TURN_CAP` in the server's
 * environment for the duration of a run. That measures a server configured differently from the one
 * being described, and it moves the knob a public demo depends on. `RATE_LIMIT_BYPASS_TOKEN` set on
 * both sides exempts the harness instead, is counted server-side as `rate_limit_bypassed`, and
 * exempts nothing but the budget: the bearer check still applies.
 *
 * Read per call rather than captured at import, because the tracer's borrower processes are forked
 * and load `.env` at their own start.
 */
export const harnessHeaders = (): Record<string, string> => {
  const bearer = process.env["API_BEARER_TOKEN"];
  const bypass = process.env["RATE_LIMIT_BYPASS_TOKEN"];
  return {
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...(bypass ? { "x-ratelimit-bypass": bypass } : {}),
  };
};

/** The same, for a request that carries a JSON body. */
export const harnessJsonHeaders = (): Record<string, string> => ({ "content-type": "application/json", ...harnessHeaders() });

/** Whether this run is exempt at all, for the report to record rather than for a caller to branch on. */
export const harnessBypassConfigured = (): boolean => Boolean(process.env["RATE_LIMIT_BYPASS_TOKEN"]);
