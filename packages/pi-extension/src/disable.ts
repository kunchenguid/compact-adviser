// The `COMPACT_ADVISER_DISABLE` session kill switch.
//
// A truthy value makes compact-adviser take no product action for that process: no
// TypeSafe judgment, no hint, no automatic compaction, no command, no status-line
// product output.
// It wins over every saved mode and every other enablement path.
//
// Keep this file byte-identical across host packages; `lockstep.test.ts` compares the
// parse across both copies.

export const DISABLE_ENV = "COMPACT_ADVISER_DISABLE";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** True when the value is `1`, `true`, `yes` or `on`, ignoring case and surrounding space. */
export function disabledByEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}
