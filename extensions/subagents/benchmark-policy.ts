/** Opt-in runner configuration for suite-declared child model policy. */
import type { BenchmarkChildLaunchPolicy } from "./hub.ts";

export const BENCHMARK_CHILD_POLICY_ENV = "PI_SUBAGENTS_BENCHMARK_CHILD_POLICY";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The environment is intentionally the only bridge from the benchmark runner
 * into the extension. An absent variable leaves every interactive preset intact.
 */
export function benchmarkChildPolicyFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): BenchmarkChildLaunchPolicy | undefined {
  const raw = environment[BENCHMARK_CHILD_POLICY_ENV]?.trim();
  if (!raw) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(`${BENCHMARK_CHILD_POLICY_ENV} must be valid JSON`);
  }
  if (!isRecord(decoded) ||
      typeof decoded.provider !== "string" || decoded.provider.trim() === "" ||
      typeof decoded.model !== "string" || decoded.model.trim() === "" ||
      typeof decoded.thinking !== "string" || decoded.thinking.trim() === "") {
    throw new Error(`${BENCHMARK_CHILD_POLICY_ENV} must declare non-empty provider, model, and thinking strings`);
  }
  return {
    provider: decoded.provider.trim(),
    model: decoded.model.trim(),
    thinking: decoded.thinking.trim(),
  };
}
