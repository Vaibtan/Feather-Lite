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
 */
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";

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
if (workers.length > 0) {
  console.log("[quiet] voice worker process(es) still running — stop them before a control-plane run:");
  for (const line of workers.split("\n")) console.log(`[quiet]   ${line.trim()}`);
} else {
  console.log("[quiet] no voice worker is running");
}

const containers = run("docker", ["ps", "--format", "{{.Names}}"]) ?? "";
console.log(`[quiet] containers up: ${containers.split("\n").filter(Boolean).join(", ") || "(none)"}`);

/**
 * WSL does not return memory to Windows unless `.wslconfig` asks it to, so `vmmemWSL` can sit on
 * several gigabytes with every container stopped. That file belongs to the user, not the repo, so
 * this warns and names the fix instead of editing it.
 */
if (process.platform === "win32") {
  const vmmem = Number(run("powershell", ["-NoProfile", "-Command", "[int]((Get-Process vmmemWSL -EA SilentlyContinue | Select-Object -First 1).WorkingSet64 / 1MB)"]) ?? 0);
  if (vmmem > 0) {
    console.log(`[quiet] vmmemWSL working set: ${String(vmmem)} MB`);
    if (vmmem > 3000) {
      console.log("[quiet]   WARNING: over 3 GB with the stack stopped. `wsl --shutdown` returns it,");
      console.log("[quiet]   and `autoMemoryReclaim=gradual` under [experimental] in %USERPROFILE%\\.wslconfig");
      console.log("[quiet]   stops it building up. Both are yours to run; this script will not.");
    }
  }
}

const free = mb(freemem());
console.log(`[quiet] free memory: ${String(free)} MB of ${String(mb(totalmem()))} MB`);
/**
 * The threshold is from measurement, not taste: the N=5 fleet run that came back 3/5 with every
 * locally-computed stage 3-5x slower started with well under 3 GB free, and the 5/5 runs that
 * followed started above it.
 */
if (free < 3000) {
  console.log("[quiet]   WARNING: under 3 GB free. A tier-2 fleet run needs about 2.5 GB for the worker tree");
  console.log("[quiet]   alone. Close the browser — it has been 7 GB on this box — and re-check.");
  process.exitCode = 1;
} else {
  console.log("[quiet] the box is quiet enough to measure on.");
}
