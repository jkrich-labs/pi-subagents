# Real-life multi-subagent benchmark harness — work breakdown

## S-01 — Turn persisted sessions into trustworthy KPI samples

- **Delivers:** A versioned benchmark sample contract can ingest bounded parent/child session fixtures and produce validated wall-time, token, tool-failure, model-pin, and quality records without provider access.
- **Blocked by:** none
- **Consumes:** pi v3 session JSONL and monotonic start/end timestamps
- **Produces:** `BenchmarkSample`, `ScenarioResult`, `UsageBreakdown`, `QualityGateResult`, session-accounting parser, finite-metric validator
- **Seam(s) to test at:** pure benchmark accounting/parser seam
- **Tier:** general — precise accounting, deduplication, malformed-input handling, and schema design cross several domain rules
- **Est. cost:** ~8k tokens / 30–45 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/benchmark-accounting.test.ts` exits 0 and covers parent/child assistant usage, cache tokens, compaction/branch usage, nested tool usage, `isError` tool results, malformed JSONL, duplicate session files/entries, and bounded diagnostics.
  - [ ] The same test proves `total_tokens` equals the sum of each unique persisted `usage.totalTokens` and `tool_failures` counts only persisted tool results with `isError: true`.
  - [ ] The same test rejects non-finite/negative metrics, mixed suite/model-policy digests, and any provider/model/thinking drift from the active suite manifest.
  - [ ] `npx tsc --noEmit -p tsconfig.json` exits 0.
- **Status:** done

## S-02 — Prove autonomous completion and enforce suite-declared model policy

- **Delivers:** A model-agnostic launch-policy seam accepts arbitrary suite-declared provider/model/thinking settings without changing normal presets. The bundled comparison policy then proves commit `568aec7` end to end with a real Luna-medium parent and child: spawn, final report, autonomous resume, and terminal marker.
- **Blocked by:** S-01
- **Consumes:** benchmark sample/model-pin contracts; existing hub delivery and launch resolution seams
- **Produces:** generic suite-declared benchmark launch policy; bundled Luna-medium comparison manifest; regression coverage for model-visible completion wake-up; one-child authenticated smoke
- **Seam(s) to test at:** hub launch resolution, extension delivery, and real parent RPC boundary
- **Tier:** general — changes lifecycle behavior at a sensitive parent/child boundary and needs deterministic plus real-provider proof
- **Est. cost:** ~10k tokens / 45–60 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/benchmark-profile.test.ts tests/ui.test.ts tests/hub.test.ts` exits 0 and proves an arbitrary declared benchmark policy reaches named and generic launches, the bundled comparison manifest resolves to `openai-codex/gpt-5.6-luna::medium`, and ordinary launches retain their presets.
  - [ ] The same tests prove DONE completion becomes a model-visible follow-up exactly once, wakes an idle parent, preserves bounded display/history entries, and does not create a retry loop.
  - [ ] `npm run benchmark:subagents -- --scenario autonomous-smoke --profile quick --output /tmp/pi-subagents-autonomous-smoke.json` exits 0 without any runner-injected continuation prompt.
  - [ ] The smoke artifact records the suite/model-policy digest, one parent and at least one child matching the bundled Luna-medium policy, a terminal marker, passing quality checks, finite KPIs, and no leaked live processes.
  - [ ] `npx tsc --noEmit -p tsconfig.json` exits 0.
- **Status:** done

## S-03 — Run parallel diagnosis and integration from a clean fixture

- **Delivers:** The benchmark runner resets a committed fixture, launches and observes a real parent, requires concurrent explorer delegation, verifies the integrated fix, writes a diagnostic JSON artifact, and cleans up on success, failure, timeout, or cancellation.
- **Blocked by:** S-01, S-02
- **Consumes:** benchmark contracts/accounting, autonomous completion, benchmark launch profile
- **Produces:** scenario contract, runner process port, fixture/worktree lifecycle, parallel-diagnosis scenario, process cleanup policy
- **Seam(s) to test at:** runner port with scripted parent/fake clock; fixture verification command; one authenticated scenario
- **Tier:** general — process lifecycle, RPC observation, fixture isolation, and quality gating form one end-to-end path
- **Est. cost:** ~14k tokens / 60–90 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/benchmark-runner.test.ts tests/benchmark-fixtures.test.ts` exits 0 and covers terminal detection, no continuation injection, timeout/cancellation, process cleanup, bounded artifacts, scope checks, model drift, child failure, role requirements, and overlap requirements.
  - [ ] `node --test tests/benchmark-fixtures.test.ts --test-name-pattern='parallel diagnosis'` proves the pristine fixture fails for the intended reasons and its verifier accepts only the complete integrated outcome.
  - [ ] `npm run benchmark:subagents -- --scenario parallel-diagnosis --profile quick --output /tmp/pi-subagents-parallel-diagnosis.json` exits 0.
  - [ ] The resulting artifact proves at least two child lifetimes overlap, expected explorer participation occurred, the parent completed autonomously, fixture verification passed, every call matches the active manifest, and all processes/worktrees were cleaned up.
  - [ ] `npx tsc --noEmit -p tsconfig.json` exits 0.
- **Status:** done

## S-04 — Cover isolated parallel implementation and review convergence

- **Delivers:** The suite adds two realistic workflows: independent child edits in pre-created worktrees that the parent integrates, and implementer-plus-parallel-review convergence that ends with verified fixes.
- **Blocked by:** S-03
- **Consumes:** runner/scenario contract, fixture lifecycle, benchmark launch profile, autonomous completion
- **Produces:** parallel-implementation fixture/scenario; review-convergence fixture/scenario; scenario-level orchestration gates
- **Seam(s) to test at:** common scenario runner and each fixture's deterministic verifier
- **Tier:** general — two multi-agent vertical workflows must stay compact, realistic, and independently diagnosable
- **Est. cost:** ~15k tokens / 60–90 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/benchmark-fixtures.test.ts tests/benchmark-scenarios.test.ts` exits 0 and proves each pristine fixture fails, each complete reference outcome passes, and partial/skipped integration fails.
  - [ ] The scenario tests require isolated `cwd` worktrees for parallel writers, at least two overlapping children, expected implementer/reviewer roles, autonomous report delivery, and final parent verification.
  - [ ] `npm run benchmark:subagents -- --scenario parallel-implementation --profile quick --output /tmp/pi-subagents-parallel-implementation.json` exits 0.
  - [ ] `npm run benchmark:subagents -- --scenario review-convergence --profile quick --output /tmp/pi-subagents-review-convergence.json` exits 0.
  - [ ] Both bundled-suite artifacts contain only the manifest's Luna-medium parent/child calls, passing quality gates, finite KPI values, bounded diagnostics, and no leaked processes/worktrees.
  - [ ] `npx tsc --noEmit -p tsconfig.json` exits 0.
- **Status:** done

## S-05 — Expose quick, confirmation, and autoresearch evaluation modes

- **Delivers:** One documented command runs the three-scenario quick suite in about five minutes; confirmation mode runs three independent samples; autoresearch mode emits independent raw KPI lines only after all hard gates pass.
- **Blocked by:** S-04
- **Consumes:** all three scenarios and versioned sample artifacts
- **Produces:** suite aggregation, median/MAD summaries, CLI/profile contract, autoresearch renderer, package scripts, operator documentation, protected-path example
- **Seam(s) to test at:** pure aggregation/rendering seam plus complete authenticated suite
- **Tier:** general — CLI, aggregation, failure semantics, and autoresearch compatibility must agree exactly
- **Est. cost:** ~10k tokens / 45–60 minutes
- **Acceptance criteria:**
  - [ ] `node --test tests/benchmark-output.test.ts tests/benchmark-runner.test.ts` exits 0 and covers quick aggregation, three-sample median/MAD, JSON schema/version, finite output, atomic artifact writes, and suppression of metric lines on any quality failure.
  - [ ] The output test proves autoresearch mode emits exactly one `METRIC wall_time_ms=...`, `METRIC total_tokens=...`, and `METRIC tool_failures=...` line with no composite score.
  - [ ] The output test proves quick mode runs one sample and confirmation mode runs three independently reset samples.
  - [ ] `npm run benchmark:subagents -- --profile quick --format autoresearch --output /tmp/pi-subagents-benchmark.json | tee /tmp/pi-subagents-benchmark.metrics` exits 0 and the metrics file contains exactly the three declared finite metric lines.
  - [ ] The quick JSON artifact shows all three scenarios passed, all required orchestration facts passed, every model call matched the bundled manifest's `openai-codex/gpt-5.6-luna::medium` policy, the suite/model-policy digest is present, and total measured runtime is reported against the five-minute target.
  - [ ] `npm run benchmark:subagents -- --help` documents profiles, authenticated cost, output paths, KPI definitions, hard gates, protected benchmark files, and pi-autoresearch integration.
  - [ ] `node --test tests/benchmark-profile.test.ts --test-name-pattern='framework policy is model agnostic|bundled comparison suite is Luna medium'` exits 0, proving Luna is configuration in the bundled manifest rather than a hardcoded runner constraint.
  - [ ] `make verify` exits 0 after the benchmark changes.
- **Status:** done

## Dependency order

`S-01 → S-02 → S-03 → S-04 → S-05`

S-03 depends on both truthful accounting and autonomous completion. The later scenarios reuse its runner and fixture lifecycle rather than creating parallel harnesses.

## Estimated total

About 57k implementation tokens and 4–6 engineering hours, plus authenticated benchmark runtime. Quick benchmark execution targets about five minutes; confirmation mode costs roughly three times one quick sample.
