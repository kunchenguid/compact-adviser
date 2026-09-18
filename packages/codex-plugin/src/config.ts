// Persistent preferences, with the same semantics as the Pi extension's configuration.
//
// Codex has no plugin-scoped settings surface: unknown keys in `config.toml` are an error
// under `--strict-config`, so the adviser owns one JSON file of its own next to its session
// records. Only the CLI writes it, so a whole-file atomic replace is the whole story; there
// is no lock because there is no concurrent writer to serialize against.
//
// `auto` is not a Codex mode. Nothing outside a Codex session can trigger `/compact`, so this
// host ships hint-only and rejects a hand-edited `auto` rather than pretending to honour it.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type Mode = "hint" | "off";
export const MODES: readonly Mode[] = ["hint", "off"];
export const DEFAULT_MINIMUM = 40000;
export const MAX_SAVED_API_KEY_LENGTH = 1024;
export const SETTINGS_NAME = "settings.json";
/** A settings file larger than this is not one this product wrote. */
const MAX_SETTINGS_BYTES = 8192;

export interface Config {
  version: 1;
  mode: Mode;
  minContextTokens: number;
  logRequests: boolean;
  typesafeApiKey?: string;
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  version: 1,
  mode: "hint",
  minContextTokens: DEFAULT_MINIMUM,
  logRequests: false,
});

export function parseMinimum(text: string): number {
  const value = text.trim();
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Enter a positive whole number of tokens, for example 40000.");
  }
  return number;
}

export const AUTO_UNAVAILABLE =
  "Automatic compaction is not available on Codex: nothing outside a session can run /compact. Use hint or off.";

export function parseMode(text: string): Mode {
  const value = text.trim();
  if (value === "auto") throw new Error(AUTO_UNAVAILABLE);
  if (!MODES.includes(value as Mode)) throw new Error("Enter hint or off.");
  return value as Mode;
}

export function parseSavedApiKey(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("Enter a TypeSafe API key, or cancel to leave it unchanged.");
  if (value.length > MAX_SAVED_API_KEY_LENGTH) {
    throw new Error("That value is too long to save as a TypeSafe API key.");
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error("The key cannot contain control characters.");
    }
  }
  return value;
}

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid settings.");
  }
  const c = value as Record<string, unknown>;
  if (
    c.version !== 1 ||
    typeof c.mode !== "string" ||
    !MODES.includes(c.mode as Mode) ||
    typeof c.minContextTokens !== "number" ||
    !Number.isSafeInteger(c.minContextTokens) ||
    c.minContextTokens <= 0 ||
    (c.logRequests !== undefined && typeof c.logRequests !== "boolean") ||
    (c.typesafeApiKey !== undefined && typeof c.typesafeApiKey !== "string")
  ) {
    throw new Error("Invalid or unsupported settings. Restore a valid version-1 configuration.");
  }
  const typesafeApiKey =
    typeof c.typesafeApiKey === "string" && c.typesafeApiKey.trim() !== ""
      ? c.typesafeApiKey.trim()
      : undefined;
  if (typesafeApiKey !== undefined && typesafeApiKey.length > MAX_SAVED_API_KEY_LENGTH) {
    throw new Error("Invalid or unsupported settings. Restore a valid version-1 configuration.");
  }
  return {
    version: 1,
    mode: c.mode as Mode,
    minContextTokens: c.minContextTokens,
    logRequests: c.logRequests === true,
    ...(typesafeApiKey !== undefined ? { typesafeApiKey } : {}),
  };
}

export class ConfigStore {
  readonly path: string;
  constructor(root: string) {
    this.path = join(root, SETTINGS_NAME);
  }

  read(): Config {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error("Unsafe settings file.");
      }
      return validateConfig(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
      throw new Error("Cannot read compact-adviser settings; no advice is given.", {
        cause: error,
      });
    }
  }

  update(patch: Partial<Omit<Config, "version">>): Config {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const config = validateConfig({ ...this.read(), ...patch });
    writeAtomic(this.path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }
}

/** Replaces `path` whole: a temporary file in the same directory, fsynced, then renamed. */
export function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup of a preferences-only temporary file.
    }
  }
}

export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}
