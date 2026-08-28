/**
 * A CPU profile of a load run, taken by the process itself.
 *
 * `node --cpu-prof` writes its profile when the process exits **cleanly**, and on Windows there is
 * no way to ask a detached console process to do that: `taskkill` without `/F` refuses, `/F`
 * terminates before anything is flushed, and `process.kill(pid, 'SIGINT')` is `TerminateProcess` in
 * disguise. So a profile of a load run — which is the evidence D5 asks each commit to carry — could
 * not be taken on the box the measurements are taken on.
 *
 * `PROFILE_SECONDS=30 pnpm start:server` instead: the process profiles itself for that long from
 * boot and writes `profile-<pid>-<timestamp>.cpuprofile` into `PROFILE_DIR` (default `./profiles`),
 * then keeps running. Load it in Chrome DevTools' Performance panel, or read the top self-time
 * frames with `scripts/cpuprof-top.mjs`.
 *
 * Off unless the variable is set, and it starts an inspector session in-process rather than opening
 * a debug port — nothing is listening for anyone to connect to.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";
import { Effect } from "effect";

export interface ProfileResult {
  readonly path: string;
  readonly seconds: number;
}

/**
 * Profile this process for `seconds`, then write the profile and resolve. Rejects nothing: a
 * profiler that fails must not take the server down with it.
 */
export const profileForSeconds = (seconds: number, dir: string): Effect.Effect<ProfileResult | null> =>
  Effect.async<ProfileResult | null>((resume) => {
    const session = new Session();
    try {
      session.connect();
    } catch {
      resume(Effect.succeed(null));
      return;
    }
    const post = (method: string): Promise<unknown> =>
      new Promise((res, rej) => {
        // The typings model each method's params individually; this helper only ever sends
        // parameterless ones, which the overloads do not express.
        (session.post as (m: string, cb: (err: Error | null, params?: unknown) => void) => void)(method, (err, params) => (err ? rej(err) : res(params)));
      });

    void (async () => {
      try {
        await post("Profiler.enable");
        await post("Profiler.start");
        await new Promise((r) => setTimeout(r, seconds * 1000));
        const result = (await post("Profiler.stop")) as { profile: unknown };
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `profile-${String(process.pid)}-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
        writeFileSync(path, JSON.stringify(result.profile));
        resume(Effect.succeed({ path, seconds }));
      } catch {
        resume(Effect.succeed(null));
      } finally {
        session.disconnect();
      }
    })();
  });

/**
 * Read `PROFILE_SECONDS` / `PROFILE_DIR` and, if asked, profile in a forked fibre so the server
 * carries on serving while it is measured — which is the only useful way to profile it.
 */
export const profileIfAsked = Effect.gen(function* () {
  const seconds = Number(process.env["PROFILE_SECONDS"] ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const dir = process.env["PROFILE_DIR"] ?? "./profiles";
  yield* Effect.logInfo(`cpu profile: sampling for ${String(seconds)}s into ${dir}`);
  yield* Effect.forkDaemon(
    profileForSeconds(seconds, dir).pipe(
      Effect.flatMap((r) => (r === null ? Effect.logWarning("cpu profile failed to start") : Effect.logInfo(`cpu profile written: ${r.path}`))),
    ),
  );
});
