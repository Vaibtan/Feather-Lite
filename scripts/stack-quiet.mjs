/**
 * `pnpm stack:quiet` — make the box quiet enough to measure on, and say whether it worked (D6).
 *
 * Every voice measurement in `docs/loadtest/README.md` is preceded by the same checklist: stop the
 * Langfuse stack, kill any worker left connected to the SFU, close the browser, check WSL has given
 * its memory back. The checklist was in a handoff document, which means it was followed from memory
 * and occasionally not at all — the 2026-08-27 N=5 that came back 3/5 was diagnosed, eventually, as
 * 7.35 GB of browser rather than a regression.
 *
 * This stops what it can stop and **reports what it cannot**. It does not close the browser and it
 * does not shut down WSL: both belong to whoever is sitting at the machine, and a script that
 * silently killed either would be worse than a checklist.
 *
 * Postgres and the SFU are left running — they are the stack a measurement needs, not noise.
 *
 * **It exits non-zero when the box is not ready** (review #19). It used to find a stray worker,
 * print it and exit 0 — so `pnpm stack:quiet && pnpm loadtest:tier2` walked straight into the
 * zombie-worker trap the script exists to prevent, with the checklist ticked. `--allow-worker` is
 * the escape for the one case where a running worker is deliberate.
 *
 * The stray-worker check looks for **host** node processes, which since 2026-09-01 makes it a
 * native-comparison-run check only: the measured stack runs in containers, where the worker has its
 * own PID namespace and nothing here can see it. A containerised worker shows up under
 * `containers up` instead.
 */
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";

/**
 * The one case where a running worker is not a zombie: a native comparison run, started on purpose
 * by whoever is about to measure it. Every other time it is the failure mode this script exists
 * for — the run looks fine and the numbers belong to a process nobody is watching.
 */
const allowWorker = process.argv.includes("--allow-worker");

const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

console.log("[quiet] stopping the Langfuse stack (Postgres and LiveKit stay up)...");
const lf = run("docker", ["compose", "-f", "deploy/langfuse/docker-compose.yml", "-p", "feather-lite-langfuse", "stop"]);
console.log(lf === null ? "[quiet]   docker is not reachable; skipped" : "[quiet]   stopped");

/**
 * A worker left connected to the SFU from an earlier session takes the next dispatch, which is the
 * single most confusing failure mode this repo has: the run looks fine and the numbers belong to a
 * process nobody is watching. Reported rather than killed — it may be the one you just started.
 */
const workers =
  process.platform === "win32"
    ? (run("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'agent\\.(ts|js)' } | ForEach-Object { \"$($_.ProcessId)  $($_.CommandLine.Substring([Math]::Max(0,$_.CommandLine.Length-70)))\" }",
      ]) ?? "")
    : (run("bash", ["-lc", "ps -eo pid,args | grep -E 'agent\\.(ts|js)' | grep -v grep"]) ?? "");
let strayWorker = false;
if (workers.length > 0) {
  strayWorker = !allowWorker;
  console.log(`[quiet] voice worker process(es) still running on the host${allowWorker ? " (allowed by --allow-worker)" : ""}:`);
  for (const line of workers.split("\n")) console.log(`[quiet]   ${line.trim()}`);
  if (strayWorker) console.log("[quiet]   Stop them, or pass --allow-worker if this one is yours and deliberate.");
} else {
  console.log("[quiet] no voice worker is running on the host");
}

const containers = run("docker", ["ps", "--format", "{{.Names}}"]) ?? "";
const containerNames = containers.split("\n").map((n) => n.trim()).filter(Boolean);
console.log(`[quiet] containers up: ${containerNames.join(", ") || "(none)"}`);

/**
 * How much memory the **worker tree** can still get, which since 2026-09-01 is usually not a
 * question about Windows.
 *
 * The verdict below has always been about one thing: can a fleet run's worker tree have the ~2.5 GB
 * it needs. On the host that was `freemem()`. In containers it is not: on Windows the containers
 * live in the WSL VM, and memory the VM has taken looks **used** to Windows even when the VM itself
 * has it free — `vmmemWSL` at 6.5 GB with 1.1 GB actually in use is the ordinary case, not a
 * pathology. Reading `freemem()` there and refusing the run is the same shape of error the
 * stray-worker check had: a host-side instrument answering a question that has moved into a
 * container.
 *
 * So the rule keeps its meaning and changes its subject: it is applied to whichever side the worker
 * tree will actually live on. Both figures are printed either way, because the borrower harness
 * still runs on the host and a host with nothing left is still a bad place to measure from.
 */
const vmAvailableMb = (() => {
  const probe = containerNames[0];
  if (probe === undefined) return null;
  const meminfo = run("docker", ["exec", probe, "cat", "/proc/meminfo"]);
  const m = meminfo === null ? null : /MemAvailable:\s+(\d+) kB/.exec(meminfo);
  return m === null ? null : Math.round(Number(m[1]) / 1024);
})();

/**
 * WSL does not return memory to Windows unless `.wslconfig` asks it to, so `vmmemWSL` can sit on
 * several gigabytes with every container stopped. That file belongs to the user, not the repo, so
 * this warns and names the fix instead of editing it.
 */
if (process.platform === "win32") {
  const vmmem = Number(run("powershell", ["-NoProfile", "-Command", "[int]((Get-Process vmmemWSL -EA SilentlyContinue | Select-Object -First 1).WorkingSet64 / 1MB)"]) ?? 0);
  if (vmmem > 0) {
    console.log(`[quiet] vmmemWSL working set: ${String(vmmem)} MB`);
    // Only when nothing is running in it. With the containers up this number is *supposed* to be
    // large — it is the memory the worker tree is using — and warning about it there would send
    // someone to `wsl --shutdown` to fix the stack they are about to measure.
    if (vmmem > 3000 && containerNames.length === 0) {
      console.log("[quiet]   WARNING: over 3 GB with the stack stopped. `wsl --shutdown` returns it,");
      console.log("[quiet]   and `autoMemoryReclaim=gradual` under [experimental] in %USERPROFILE%\\.wslconfig");
      console.log("[quiet]   stops it building up. Both are yours to run; this script will not.");
    }
  }
}

const free = mb(freemem());
console.log(`[quiet] free memory (host): ${String(free)} MB of ${String(mb(totalmem()))} MB`);
if (vmAvailableMb !== null) console.log(`[quiet] free memory (container VM, where the worker tree lives): ${String(vmAvailableMb)} MB`);

/**
 * The threshold is from measurement, not taste: the N=5 fleet run that came back 3/5 with every
 * locally-computed stage 3-5x slower started with well under 3 GB free, and the 5/5 runs that
 * followed started above it. It is 2.5 GB for the worker tree plus room to breathe.
 */
const judged = vmAvailableMb ?? free;
const lowMemory = judged < 3000;
if (lowMemory) {
  console.log(`[quiet]   WARNING: under 3 GB available ${vmAvailableMb === null ? "on the host" : "in the container VM"}. A tier-2 fleet run needs`);
  console.log("[quiet]   about 2.5 GB for the worker tree alone. Close the browser — it has been 7 GB on this");
  console.log("[quiet]   box — and re-check.");
}

/**
 * One verdict, and the exit code is it (review #19).
 *
 * Both findings are disqualifying, and for the same reason: a run that starts against either
 * produces numbers that belong to something other than what is being measured. Which one failed
 * matters more than the code, because the two have different fixes.
 */
if (lowMemory || strayWorker) {
  const why = [strayWorker ? "a stray voice worker" : null, lowMemory ? `not enough free memory ${vmAvailableMb === null ? "on the host" : "in the container VM"}` : null].filter(Boolean).join(" and ");
  console.log(`[quiet] NOT quiet enough to measure on: ${why}.`);
  process.exitCode = 1;
} else {
  console.log("[quiet] the box is quiet enough to measure on.");
}
