// The judge provider's key (TYPESAFE_API_KEY, or AI_GATEWAY_API_KEY for Vercel's AI Gateway) from the
// hook environment, else the key saved in settings, else a cwd .env file.
// KEY=VALUE lines: last assignment wins; comments and blanks are ignored.
// Optional `export` / `declare -x` prefixes and one matching quote layer.

import {
  GATEWAY_ADAPTER,
  JUDGE_PROVIDERS,
  type JudgeAdapter,
  type JudgeProvider,
  typesafeAdapter,
} from "./judge.ts";

const PREFIX = /^(?:export|declare\s+-x)\s+/;

export type TypesafeKeySource = "env" | "saved" | ".env" | "missing";
export interface ResolvedTypesafeApiKey {
  value: string | undefined;
  source: TypesafeKeySource;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}

/** Last `KEY=VALUE` assignment wins. Comments and blank lines are ignored. */
export function parseDotenvKey(text: string, name: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(PREFIX, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    found = unquote(line.slice(eq + 1).trim());
  }
  return found;
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * A non-empty host env value wins, then a menu-saved key, then a parsed .env
 * assignment. Missing pieces are skipped; the value is never logged.
 */
export function resolveTypesafeApiKey(
  envValue: string | undefined,
  saved?: string,
  dotenvValue?: string,
): ResolvedTypesafeApiKey {
  const fromEnv = nonempty(envValue);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const fromSaved = nonempty(saved);
  if (fromSaved !== undefined) return { value: fromSaved, source: "saved" };
  const fromFile = nonempty(dotenvValue);
  if (fromFile !== undefined) return { value: fromFile, source: ".env" };
  return { value: undefined, source: "missing" };
}

export function formatKeyStatus(source: TypesafeKeySource): string {
  return `Key: ${source}`;
}

/** Names the judge provider from the launch environment: `typesafe` or `vercel`. */
export const PROVIDER_ENV = "COMPACT_ADVISER_JUDGE_PROVIDER";
/**
 * Each provider's own key variable and saved field. A TypeSafe key is never sent to the
 * gateway, nor a gateway key to TypeSafe.
 */
export const KEY_NAMES: Readonly<Record<JudgeProvider, string>> = {
  typesafe: "TYPESAFE_API_KEY",
  vercel: "AI_GATEWAY_API_KEY",
};
export const SAVED_KEY_FIELDS = {
  typesafe: "typesafeApiKey",
  vercel: "aiGatewayApiKey",
} as const;
export const KEY_LABELS: Readonly<Record<JudgeProvider, string>> = {
  typesafe: "TypeSafe API key",
  vercel: "AI Gateway API key",
};

export type JudgeProviderSource = "env" | "saved" | "default";
export interface ResolvedJudgeProvider {
  /** Undefined when the setting names no provider: then no judgment is requested. */
  provider: JudgeProvider | undefined;
  source: JudgeProviderSource;
}

function knownProvider(value: string): JudgeProvider | undefined {
  const name = value.trim();
  return JUDGE_PROVIDERS.includes(name as JudgeProvider) ? (name as JudgeProvider) : undefined;
}

export function parseJudgeProvider(text: string): JudgeProvider {
  const provider = knownProvider(text);
  if (provider === undefined) throw new Error("Enter typesafe or vercel.");
  return provider;
}

/**
 * A non-empty launch-environment value wins, then the saved setting, then TypeSafe. A value
 * naming no provider resolves to none, so invalid configuration gives no advice rather than
 * a fallback. A working directory's .env never chooses where checkpoint context goes.
 */
export function resolveJudgeProvider(
  envValue: string | undefined,
  saved?: string,
): ResolvedJudgeProvider {
  const fromEnv = nonempty(envValue);
  if (fromEnv !== undefined) return { provider: knownProvider(fromEnv), source: "env" };
  const fromSaved = nonempty(saved);
  if (fromSaved !== undefined) return { provider: knownProvider(fromSaved), source: "saved" };
  return { provider: "typesafe", source: "default" };
}

export interface ResolvedJudge extends ResolvedJudgeProvider {
  /** Undefined when the settings name no usable judge: then no judgment is requested. */
  adapter: JudgeAdapter | undefined;
  /** Why there is no adapter, in the words status shows. */
  problem?: string;
}

/** The judge in effect (see `resolveJudgeProvider`) and the adapter that carries its request. */
export function resolveJudge(
  providerEnv: string | undefined,
  savedProvider?: string,
): ResolvedJudge {
  const resolved = resolveJudgeProvider(providerEnv, savedProvider);
  if (resolved.provider === undefined) {
    const where = resolved.source === "env" ? PROVIDER_ENV : "the saved judge setting";
    return {
      ...resolved,
      adapter: undefined,
      problem: `${where} names no provider (use typesafe or vercel)`,
    };
  }
  return {
    ...resolved,
    adapter: resolved.provider === "vercel" ? GATEWAY_ADAPTER : typesafeAdapter(),
  };
}

/** Where eligible checkpoint context goes, in the words status shows. */
export function describeJudge(adapter: JudgeAdapter): string {
  return adapter.provider === "vercel"
    ? "Jev through Vercel's AI Gateway (checkpoint context goes to Vercel's AI Gateway on its way to Jev)"
    : "TypeSafe Jev (checkpoint context goes to TypeSafe)";
}

export function formatJudgeStatus(judge: ResolvedJudge): string {
  return judge.adapter
    ? `Judge: ${describeJudge(judge.adapter)}`
    : `Judge: none, ${judge.problem}; no advice is given`;
}

/** The confirmation for a saved judge: what it now sends where, and what still overrides it. */
export function judgeSavedMessage(
  provider: JudgeProvider,
  providerEnv: string | undefined,
): string {
  const saved = resolveJudge(undefined, provider);
  const what = saved.adapter
    ? describeJudge(saved.adapter)
    : `none, ${saved.problem}; no advice is given`;
  const overridden =
    nonempty(providerEnv) !== undefined
      ? ` ${PROVIDER_ENV} in the launch environment still wins.`
      : "";
  return `Judge saved (all sessions): ${what}. It asks with ${KEY_NAMES[provider]} or a saved ${KEY_LABELS[provider]}.${overridden}`;
}
