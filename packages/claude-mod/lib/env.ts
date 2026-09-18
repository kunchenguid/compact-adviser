// OPENROUTER_API_KEY from the host environment, else a menu-saved key, else a cwd .env file.
// KEY=VALUE lines: last assignment wins; comments and blanks are ignored.
// Optional `export` / `declare -x` prefixes and one matching quote layer.

const PREFIX = /^(?:export|declare\s+-x)\s+/;

export type OpenRouterKeySource = "env" | "saved" | ".env" | "missing";
export interface ResolvedOpenRouterApiKey {
  value: string | undefined;
  source: OpenRouterKeySource;
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
export function resolveOpenRouterApiKey(
  envValue: string | undefined,
  saved?: string,
  dotenvValue?: string,
): ResolvedOpenRouterApiKey {
  const fromEnv = nonempty(envValue);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const fromSaved = nonempty(saved);
  if (fromSaved !== undefined) return { value: fromSaved, source: "saved" };
  const fromFile = nonempty(dotenvValue);
  if (fromFile !== undefined) return { value: fromFile, source: ".env" };
  return { value: undefined, source: "missing" };
}

export function formatKeyStatus(source: OpenRouterKeySource): string {
  return `Key: ${source}`;
}
