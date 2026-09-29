// Persistent preferences, with the same semantics as the Pi extension's configuration.
//
// `mode`, `minContextTokens`, and `logRequests` are the plugin's manifest `userConfig` rows: the host
// validates them, stores them in the user's settings.json, and shows them in /config.
// `judgeProvider` is a userConfig row too: `typesafe` or `vercel` (Vercel's AI Gateway).
// `typesafeApiKey` and `aiGatewayApiKey` are also userConfig rows so they live in that same
// settings path, but this module hides them from `/config` so a secret is never drawn there.
// Set, clear, and presence are the compact-adviser pane's job.
// `autoAcknowledged` lives in the plugin's own store so that only this mod's confirmation
// dialog can grant experimental automatic mode. A legacy `sharingConsent` field is ignored.

import { JUDGE_PROVIDERS, type JudgeProvider } from "./judge.ts";
import { parseProfile } from "./profile.ts";

export type Mode = "hint" | "auto" | "off";
export const MODES: readonly Mode[] = ["hint", "auto", "off"];
export const PLUGIN = "compact-adviser";
export const MODE_KEY = `${PLUGIN}.mode`;
export const MINIMUM_KEY = `${PLUGIN}.minContextTokens`;
export const LOG_KEY = `${PLUGIN}.logRequests`;
export const PROFILE_KEY = `${PLUGIN}.profile`;
export const API_KEY_KEY = `${PLUGIN}.typesafeApiKey`;
export const JUDGE_KEY = `${PLUGIN}.judgeProvider`;
export const GATEWAY_API_KEY_KEY = `${PLUGIN}.aiGatewayApiKey`;
/** Each judge's saved-key row. */
export const SAVED_KEY_ROWS: Readonly<Record<JudgeProvider, string>> = {
  typesafe: API_KEY_KEY,
  vercel: GATEWAY_API_KEY_KEY,
};
export const CONSENT_STORE_KEY = "preferences";
export const DEFAULT_MINIMUM = 40000;
export const MAX_SAVED_API_KEY_LENGTH = 1024;

export interface Config {
  mode: Mode;
  minContextTokens: number;
  autoAcknowledged: boolean;
  logRequests: boolean;
  /** The saved judge setting; the launch environment may still override it. */
  judgeProvider?: JudgeProvider;
  profile?: string;
}

export interface Consent {
  version: 1;
  autoAcknowledged: boolean;
}

export const DEFAULT_CONSENT: Readonly<Consent> = Object.freeze({
  version: 1,
  autoAcknowledged: false,
});

export function parseMinimum(text: string): number {
  const value = text.trim();
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Enter a positive whole number of tokens, for example 40000.");
  }
  return number;
}

export function parseSavedApiKey(text: string, label = "TypeSafe API key"): string {
  const value = text.trim();
  if (!value) throw new Error(`Enter a ${label}, or cancel to leave it unchanged.`);
  if (value.length > MAX_SAVED_API_KEY_LENGTH) {
    throw new Error(`That value is too long to save as a ${label}.`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error("The key cannot contain control characters.");
    }
  }
  return value;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Reads the stored acknowledgement record; absent means the defaults, anything malformed throws. */
export function parseConsent(value: unknown): Consent {
  if (value === undefined) return { ...DEFAULT_CONSENT };
  const c = value as Record<string, unknown> | null;
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    c.version !== 1 ||
    typeof c.autoAcknowledged !== "boolean"
  ) {
    throw new SettingsError(
      "Invalid compact-adviser consent record; run /compact-adviser auto to restore it.",
    );
  }
  return { version: 1, autoAcknowledged: c.autoAcknowledged };
}

export interface ConfigRowLike {
  key: string;
  value: unknown;
}

/**
 * Combines the host's `userConfig` values with the stored automatic-mode acknowledgement.
 * The live `/config` rows win, so a change another session saved is seen at once; the
 * options the module loaded with (host-validated, defaults filled in) stand in for a row
 * the menu has not listed yet, as happens at startup. The host already maps a stored mode
 * outside the options to its `hint` default; a value of the wrong kind is reported rather
 * than silently replaced. A legacy `sharingConsent` field is ignored: installing the
 * package is consent to send eligible checkpoint context when a key is available.
 */
export function readConfig(
  rows: readonly ConfigRowLike[],
  consentValue: unknown,
  loaded: Readonly<Record<string, unknown>> = {},
): Config {
  const row = (key: string, field: string) =>
    rows.find((candidate) => candidate.key === key)?.value ?? loaded[field];
  const mode = row(MODE_KEY, "mode");
  const minimum = row(MINIMUM_KEY, "minContextTokens");
  const logRequests = row(LOG_KEY, "logRequests");
  if (typeof mode !== "string" || !MODES.includes(mode as Mode)) {
    throw new SettingsError("Cannot read the compact-adviser mode setting; no action is taken.");
  }
  if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum <= 0) {
    throw new SettingsError(
      "Cannot read the compact-adviser minimum context setting; no action is taken.",
    );
  }
  if (logRequests !== undefined && typeof logRequests !== "boolean") {
    throw new SettingsError(
      "Cannot read the compact-adviser request-log setting; no action is taken.",
    );
  }
  const judgeProvider = row(JUDGE_KEY, "judgeProvider");
  if (
    judgeProvider !== undefined &&
    judgeProvider !== "" &&
    !JUDGE_PROVIDERS.includes(judgeProvider as JudgeProvider)
  ) {
    throw new SettingsError("Cannot read the compact-adviser judge setting; no action is taken.");
  }
  const profile = row(PROFILE_KEY, "profile");
  parseProfile(profile);
  const consent = parseConsent(consentValue);
  return {
    mode: mode as Mode,
    minContextTokens: minimum,
    autoAcknowledged: consent.autoAcknowledged,
    logRequests: logRequests === true,
    ...(judgeProvider ? { judgeProvider: judgeProvider as JudgeProvider } : {}),
    ...(profile !== undefined ? { profile: profile as string } : {}),
  };
}

/** A judge's menu-saved key from live `/config` rows or the options this module loaded with. */
export function readSavedApiKey(
  rows: readonly ConfigRowLike[],
  loaded: Readonly<Record<string, unknown>> = {},
  provider: JudgeProvider = "typesafe",
): string | undefined {
  const key = SAVED_KEY_ROWS[provider];
  const value =
    rows.find((candidate) => candidate.key === key)?.value ?? loaded[key.slice(PLUGIN.length + 1)];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}
