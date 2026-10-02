import type { ExecutionLayer } from "./types";

/**
 * Hard-coded off. The EXECUTION_ENABLED environment variable is documented
 * for forward compatibility but is intentionally not read: setting it cannot
 * enable code that does not exist.
 */
export const EXECUTION_ENABLED = false as const;

export const EXECUTION_DISABLED_MESSAGE =
  "Execution is disabled in this build. It requires an audited implementation.";

export function assertExecutionDisabled(): never {
  throw new Error(EXECUTION_DISABLED_MESSAGE);
}

export function getExecutionLayer(): ExecutionLayer {
  return assertExecutionDisabled();
}

export type * from "./types";
