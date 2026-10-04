---
name: "diagnosing-bugs"
description: "Diagnose a difficult, intermittent, or poorly understood bug or performance regression using source, logs, reproduction, and measurements."
---

# Diagnosing bugs

Bound the symptom, expected behavior, affected version/environment, and evidence. Inspect source, logs, and recent changes to form a reproduction; a runnable failure need not exist before investigation begins.

Build the smallest faithful reproduction or measurement. Separate observed facts from hypotheses and test the most discriminating explanation first. Use as many hypotheses as the evidence needs; scale execution time to the system.

Change the responsible behavior, then rerun the reproduction and relevant regression checks. For concurrency, persistence, cancellation, or performance, exercise the real mechanism that failed and compare under equivalent conditions. A green unrelated unit test is not proof.

Remove temporary instrumentation unless useful diagnostics belong in the product. Finish with the cause, fix, measured result, and remaining uncertainty. If blocked on credentials, hardware, or unavailable logs, preserve a runnable reproduction and explain the missing evidence.
