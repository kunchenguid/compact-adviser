// Where this adapter keeps its own records.
//
// Not `~/.codex/config.toml`: Codex errors on unknown keys under `--strict-config`. Not the
// plugin's `PLUGIN_DATA` directory either, because that path is namespaced by the marketplace
// a plugin was installed from and the settings CLI can be run without it in the environment.
// One directory under CODEX_HOME survives both.

import { homedir } from "node:os";
import { join } from "node:path";

export const DIRECTORY = "compact-adviser";

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? configured : join(homedir(), ".codex");
}

/** The adviser's own directory: settings, per-session cooldowns, and request logs. */
export function adviserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), DIRECTORY);
}
