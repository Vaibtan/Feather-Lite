import { describe, expect, it, vi } from "vitest";
import { resumeIfBackchannel, shouldResume } from "../src/resume-backchannel.js";

const paused = { pausedSpeech: { handle: {} }, startFalseInterruptionTimer: () => {} };
const idle = { pausedSpeech: undefined, startFalseInterruptionTimer: () => {} };

describe("shouldResume", () => {
  it("resumes on a backchannel while a speech is paused", () => {
    expect(shouldResume("mm-hm", paused)).toEqual({ resume: true, why: "resumed" });
  });

  it("does nothing when nothing is paused, which is every ordinary interim", () => {
    expect(shouldResume("mm-hm", idle).why).toBe("not-paused");
  });

  it("does nothing when the borrower is actually saying something", () => {
    // The expensive mistake: resuming over a borrower who is genuinely speaking is worse than the
    // pause this exists to avoid.
    expect(shouldResume("okay but I can't pay that", paused).why).toBe("not-a-backchannel");
  });

  it("does nothing for a bare yes, which during the read-back is the confirmation", () => {
    expect(shouldResume("yes", paused).why).toBe("not-a-backchannel");
  });

  it("reports the missing seam rather than throwing, if the SDK shape ever changes", () => {
    // The coupling is to `session._activity`, which the SDK documents but does not guarantee. A
    // worker that crashes on a transcript is worse than one that stops resuming early.
    expect(shouldResume("mm-hm", undefined).why).toBe("no-seam");
    expect(shouldResume("mm-hm", { pausedSpeech: {} }).why).toBe("no-seam");
  });
});

describe("resumeIfBackchannel", () => {
  it("re-arms the SDK's own timer at zero rather than resuming by hand", () => {
    const timer = vi.fn();
    expect(resumeIfBackchannel("yeah", { pausedSpeech: {}, startFalseInterruptionTimer: timer })).toBe(true);
    expect(timer).toHaveBeenCalledWith(0);
  });

  it("leaves the ordinary timeout running when it declines", () => {
    const timer = vi.fn();
    expect(resumeIfBackchannel("I can pay Friday", { pausedSpeech: {}, startFalseInterruptionTimer: timer })).toBe(false);
    expect(timer).not.toHaveBeenCalled();
  });
});
