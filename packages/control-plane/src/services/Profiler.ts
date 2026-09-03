/**
 * The process profiles itself because `node --cpu-prof` only writes on a clean exit, and on Windows
 * a detached console process cannot be asked for one: `taskkill` without `/F` refuses, `/F` kills
 * before the flush, and `process.kill(pid, 'SIGINT')` is `TerminateProcess` in disguise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";
import { Effect } from "effect";

export interface ProfileResult {
  readonly path: string;
  readonly seconds: number;
}

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
