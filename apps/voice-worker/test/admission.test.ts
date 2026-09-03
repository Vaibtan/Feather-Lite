import { describe, expect, it } from "vitest";
import { createAdmissionController } from "../src/admission.js";

/** A `JobRequest` whose `accept()` resolves immediately — which is what the real one does. */
const fakeRequest = (id: string) => {
  const calls = { accepted: false, rejected: false };
  return {
    calls,
    req: {
      id,
      accept: async () => {
        calls.accepted = true;
      },
      reject: async () => {
        calls.rejected = true;
      },
    },
  };
};

/** A clock the test drives: `sleep` advances it, so polling terminates deterministically. */
const fakeClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await Promise.resolve();
    },
  };
};

describe("admission control", () => {
  it("refuses the third simultaneous request against a ceiling of two", async () => {
    const clock = fakeClock();
    // Never populated: this is the window between the accept and `launchJob`, where the burst
    // arrives.
    const active: string[] = [];
    const admission = createAdmissionController({
      maxJobs: 2,
      activeJobIds: () => active,
      now: clock.now,
      sleep: clock.sleep,
    });

    const one = fakeRequest("job-1");
    const two = fakeRequest("job-2");
    const three = fakeRequest("job-3");

    const p1 = admission.requestFunc(one.req);
    const p2 = admission.requestFunc(two.req);
    expect(admission.admitting()).toBe(2);
    expect(admission.inFlight()).toBe(2);

    await admission.requestFunc(three.req);

    expect(one.calls.accepted).toBe(true);
    expect(two.calls.accepted).toBe(true);
    expect(three.calls.accepted).toBe(false);
    expect(three.calls.rejected).toBe(true);

    await Promise.all([p1, p2]);
    expect(admission.admitting()).toBe(0);
  });

  it("releases the slot once the job appears in activeJobs", async () => {
    const clock = fakeClock();
    const active: string[] = [];
    const admission = createAdmissionController({
      maxJobs: 1,
      activeJobIds: () => active,
      now: clock.now,
      sleep: clock.sleep,
    });

    const one = fakeRequest("job-1");
    const admitted = admission.requestFunc(one.req);
    expect(admission.admitting()).toBe(1);

    // What `launchJob` does: the job becomes visible as a running job.
    active.push("job-1");
    await admitted;

    expect(admission.admitting()).toBe(0);
    expect(admission.inFlight()).toBe(1);

    const two = fakeRequest("job-2");
    await admission.requestFunc(two.req);
    expect(two.calls.rejected).toBe(true);
  });

  it("does not hold a slot forever when the assignment never lands", async () => {
    const clock = fakeClock();
    const logged: string[] = [];
    const admission = createAdmissionController({
      maxJobs: 1,
      activeJobIds: () => [],
      assignmentTimeoutMs: 8_000,
      now: clock.now,
      sleep: clock.sleep,
      log: (message) => logged.push(message),
    });

    const one = fakeRequest("job-1");
    await admission.requestFunc(one.req);

    expect(one.calls.accepted).toBe(true);
    expect(admission.admitting()).toBe(0);
    expect(clock.now()).toBeGreaterThanOrEqual(8_000);
    expect(logged.some((m) => m.includes("never reached activeJobs"))).toBe(true);

    const two = fakeRequest("job-2");
    const next = admission.requestFunc(two.req);
    expect(two.calls.rejected).toBe(false);
    expect(two.calls.accepted).toBe(true);
    await next;
  });

  it("stops waiting when the worker is shutting down, so close() is not held for the timeout", async () => {
    const clock = fakeClock();
    const admission = createAdmissionController({
      maxJobs: 1,
      activeJobIds: () => [],
      assignmentTimeoutMs: 8_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    const one = fakeRequest("job-1");
    const waiting = admission.requestFunc(one.req);
    admission.abandonWaits();
    await waiting;

    expect(admission.admitting()).toBe(0);
    expect(clock.now()).toBeLessThan(8_000);
  });

  it("counts a job once when it is both admitting and already running", async () => {
    const clock = fakeClock();
    const active: string[] = [];
    const admission = createAdmissionController({ maxJobs: 2, activeJobIds: () => active, now: clock.now, sleep: clock.sleep });

    const one = fakeRequest("job-1");
    const waiting = admission.requestFunc(one.req);
    // `launchJob` has run; the poll has not yet noticed.
    active.push("job-1");
    expect(admission.admitting()).toBe(1);
    expect(admission.inFlight()).toBe(1);

    const two = fakeRequest("job-2");
    const second = admission.requestFunc(two.req);
    expect(two.calls.rejected).toBe(false);
    expect(two.calls.accepted).toBe(true);
    expect(admission.inFlight()).toBe(2);

    active.push("job-2");
    await Promise.all([waiting, second]);
  });

  it("counts running jobs against the ceiling as well as admitting ones", async () => {
    const admission = createAdmissionController({
      maxJobs: 2,
      activeJobIds: () => ["job-a", "job-b"],
      now: () => 0,
      sleep: async () => undefined,
    });

    const three = fakeRequest("job-c");
    await admission.requestFunc(three.req);
    expect(three.calls.rejected).toBe(true);
    expect(admission.inFlight()).toBe(2);
  });

  it("says why it refused, with the numbers", async () => {
    const logged: Array<{ message: string; extra: Record<string, unknown> }> = [];
    const admission = createAdmissionController({
      maxJobs: 1,
      activeJobIds: () => ["job-a"],
      log: (message, extra) => logged.push({ message, extra }),
    });

    await admission.requestFunc(fakeRequest("job-b").req);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toContain("refusing job job-b");
    expect(logged[0]?.extra).toEqual({ in_flight: 1, running: 1, admitting: 0, max_jobs: 1 });
  });
});

describe("a worker that is shutting down", () => {
  it("refuses a job offered during the drain instead of accepting it into a pool being torn down", async () => {
    const controller = createAdmissionController({
      maxJobs: 8,
      activeJobIds: () => [],
      log: () => undefined,
      assignmentTimeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    // Plenty of capacity: the refusal is about the drain, not the ceiling.
    controller.abandonWaits();
    const late = fakeRequest("job-late");
    await controller.requestFunc(late.req);
    expect(late.calls.rejected).toBe(true);
    expect(late.calls.accepted).toBe(false);
  });
});
