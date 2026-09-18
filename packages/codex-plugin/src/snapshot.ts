// The bounded, text-only judge input built from the Codex rollout transcript, following the
// Pi extension's snapshot: user constraints, the recent tail, the prior summary, saved
// artifact names, and explicit coverage markers.
//
// The redaction helpers (`redact`, `redactOwnedSettings`, `scrubKnownSecrets`) are the Pi
// extension's and the Claude mod's byte for byte; test/lockstep.test.ts in the Pi package
// enforces that. Only the host-shaped parts differ: Codex writes files through `apply_patch`,
// which names several paths in one call, so a tool use carries `paths` instead of `file_path`.

export interface ToolUseLike {
  tool_use_id?: string;
  tool: string;
  /** Workspace paths this call wrote, already extracted from the host's tool input. */
  paths?: readonly string[];
  /** Workspace paths this call deleted or moved away from. */
  removedPaths?: readonly string[];
  text?: string;
  isError?: true;
}

export interface MessageLike {
  role: "user" | "assistant";
  text: string;
  toolUses: readonly ToolUseLike[];
  toolResults?: readonly { text: string; isError: boolean }[];
  hasImages?: boolean;
}

/** Rollout records mapped per read; a full answer means older transcript entries were dropped. */
export const MESSAGE_LIMIT = 4096;
/** Recent transcript entries considered for the TypeSafe/Jev snapshot, including assistant tool results. */
export const RECENT_TAIL_MESSAGES = 64;
/** Per-tool-result byte cap inside the recent tail; long results are middle-truncated. */
export const TOOL_RESULT_BUDGET = 512;
export const SUMMARY_PREFIX = "This session is being continued from a previous conversation";
/** Codex tool calls that write workspace files; `apply_patch` is the freeform one. */
const WRITE_TOOLS = new Set(["apply_patch", "write_file", "edit_file"]);

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= limit) return { text, truncated: false };
  const cut = new TextDecoder().decode(encoded.subarray(0, Math.max(0, limit - 3)));
  // A multi-byte character split at the cut decodes as U+FFFD; drop it.
  return { text: cut.replace(/�$/, ""), truncated: true };
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function truncatedMarker(omitted: number): string {
  return `...[truncated ${omitted} bytes]...`;
}

/** Keep a head and tail slice so one long tool dump cannot hide its start or end. */
export function clipMiddle(text: string, limit: number): { text: string; truncated: boolean } {
  const raw = new TextEncoder().encode(text);
  if (raw.byteLength <= limit) return { text, truncated: false };
  if (limit <= 0) return { text: "", truncated: true };
  let omitted = raw.byteLength;
  let head = 0;
  let tail = 0;
  for (let i = 0; i < 5; i++) {
    const markerBytes = bytes(truncatedMarker(omitted));
    if (markerBytes >= limit) return clip(text, limit);
    const keep = limit - markerBytes;
    head = Math.ceil(keep / 2);
    tail = Math.floor(keep / 2);
    omitted = Math.max(0, raw.byteLength - head - tail);
  }
  const marker = truncatedMarker(omitted);
  const out = new Uint8Array(head + bytes(marker) + tail);
  out.set(raw.subarray(0, head), 0);
  out.set(new TextEncoder().encode(marker), head);
  out.set(raw.subarray(raw.byteLength - tail), head + bytes(marker));
  return { text: new TextDecoder().decode(out).replace(/�/g, ""), truncated: true };
}

const sensitivePath =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|ed25519)|[^\\/]*\.(?:pem|key))$/i;

function isOwnedSecretField(key: string): boolean {
  return key === "typesafeApiKey" || key.endsWith(".typesafeApiKey");
}

function redactOwnedSecretFields(value: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (isOwnedSecretField(key) && child !== "" && child != null) {
          out[key] = "[REDACTED]";
          redacted = true;
        } else out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value), redacted };
}

/** Strip the product's saved-key fields from JSON text; keep non-secret settings. */
export function redactOwnedSettings(text: string): { text: string; redacted: boolean } {
  if (!text.includes("typesafeApiKey")) return { text, redacted: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    const walked = redactOwnedSecretFields(parsed);
    if (walked.redacted) return { text: JSON.stringify(walked.value), redacted: true };
  } catch {
    // Clipped or non-JSON tool output still goes through the field regex below.
  }
  const clean = text
    .replace(/("(?:[^"\\]*\.)?typesafeApiKey")\s*:\s*"(?:\\.|[^"\\])*"/g, '$1:"[REDACTED]"')
    .replace(/\b(typesafeApiKey)\s*[=:]\s*["']?[^\s"',}]+/g, "$1=[REDACTED]");
  return { text: clean, redacted: clean !== text };
}

export function scrubKnownSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): { text: string; redacted: boolean } {
  let clean = text;
  let redacted = false;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || !clean.includes(value)) continue;
    clean = clean.split(value).join("[REDACTED]");
    redacted = true;
  }
  return { text: clean, redacted };
}

export function redact(text: string): { text: string; redacted: boolean } {
  const fields = redactOwnedSettings(text);
  const clean = fields.text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|Bearer\s+\S+)/gi, "[REDACTED]")
    .replace(
      /\b([A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*["']?[^\s"',}]+/g,
      "$1=[REDACTED]",
    );
  return { text: clean, redacted: fields.redacted || clean !== fields.text };
}

function sanitizeText(
  text: string,
  secrets: readonly (string | undefined)[],
): { text: string; redacted: boolean } {
  const cleaned = redact(text);
  const scrubbed = scrubKnownSecrets(cleaned.text, secrets);
  return { text: scrubbed.text, redacted: cleaned.redacted || scrubbed.redacted };
}

function toolPaths(use: ToolUseLike): readonly string[] {
  return use.paths ?? [];
}

/** A local estimate of the conversation's own tokens (about four characters per token). */
export function estimateConversationTokens(messages: readonly MessageLike[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.text.length;
    for (const use of m.toolUses)
      chars += use.tool.length + toolPaths(use).join("").length + (use.text?.length ?? 0);
    for (const result of m.toolResults ?? []) chars += result.text.length;
  }
  return Math.ceil(chars / 4);
}

export interface Snapshot {
  state: {
    userConstraints: { role: "user"; text: string }[];
    recent: {
      role: string;
      text: string;
      tools?: { tool: string; error: boolean; excerpt: string }[];
    }[];
    previousSummary: string;
    savedArtifacts: string[];
    coverage: {
      omittedUserMessages: number;
      olderMessagesOmitted: number;
      recentTextTruncated: boolean;
      hasImages: boolean;
      redacted: boolean;
      transcriptLimitReached: boolean;
    };
    compaction: { description: string };
  };
  conversationTokens: number;
  /** The text the checkpoint fingerprint is taken over: the latest ask and reply. */
  checkpointText: string;
  autoCoverage: boolean;
}

export function snapshot(
  messages: readonly MessageLike[],
  secrets: readonly (string | undefined)[] = [],
  options: { truncated?: boolean } = {},
): Snapshot {
  const artifacts = new Set<string>();
  let redacted = false;
  let omittedUsers = 0;
  let recentTruncated = false;
  let userBudget = 8000;
  let tailBudget = 14000;
  let summary = "";
  const users: { role: "user"; text: string }[] = [];
  const recent: Snapshot["state"]["recent"] = [];

  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.isError || !WRITE_TOOLS.has(use.tool)) continue;
      for (const path of use.removedPaths ?? []) {
        if (sensitivePath.test(path)) continue;
        artifacts.delete(path);
      }
      for (const path of toolPaths(use)) {
        if (sensitivePath.test(path)) continue;
        artifacts.delete(path);
        artifacts.add(path);
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user" && m.text.startsWith(SUMMARY_PREFIX)) {
      if (!summary) {
        const s = sanitizeText(m.text, secrets);
        summary = clip(s.text, 1500).text;
        redacted ||= s.redacted;
      }
      continue;
    }
    const cleaned = sanitizeText(m.text, secrets);
    redacted ||= cleaned.redacted;
    if (m.role === "user" && cleaned.text.trim()) {
      const part = clip(cleaned.text, userBudget);
      if (part.truncated) omittedUsers++;
      if (part.text) users.unshift({ role: "user", text: part.text });
      userBudget = Math.max(0, userBudget - bytes(part.text));
    } else if (m.role === "assistant" && i >= messages.length - RECENT_TAIL_MESSAGES) {
      const part = clip(cleaned.text, Math.min(tailBudget, 8000));
      recentTruncated ||= part.truncated;
      tailBudget = Math.max(0, tailBudget - bytes(part.text));
      const tools = m.toolUses.map((use) => {
        let excerpt: string;
        if (toolPaths(use).some((path) => sensitivePath.test(path))) {
          excerpt = "[Sensitive file content excluded]";
          redacted = true;
        } else {
          const r = sanitizeText(use.text ?? "", secrets);
          redacted ||= r.redacted;
          const c = clipMiddle(r.text, Math.min(tailBudget, TOOL_RESULT_BUDGET));
          recentTruncated ||= c.truncated;
          excerpt = c.text;
        }
        tailBudget = Math.max(0, tailBudget - bytes(excerpt));
        return { tool: use.tool, error: use.isError === true, excerpt };
      });
      recent.unshift({ role: "assistant", text: part.text, ...(tools.length ? { tools } : {}) });
    }
  }

  const lastUser = users.at(-1)?.text ?? "";
  const lastAssistant = recent.at(-1)?.text ?? "";
  const truncated = options.truncated === true;
  const transcriptLimitReached = messages.length >= MESSAGE_LIMIT || truncated;
  const hasImages = messages.some((m) => m.hasImages === true);
  const state: Snapshot["state"] = {
    userConstraints: users,
    recent,
    previousSummary: summary,
    savedArtifacts: [...artifacts].slice(-8).map((p) => {
      const cleaned = sanitizeText(p, secrets);
      redacted ||= cleaned.redacted;
      return clip(cleaned.text, 256).text;
    }),
    coverage: {
      omittedUserMessages: omittedUsers,
      olderMessagesOmitted: Math.max(truncated ? 1 : 0, messages.length - RECENT_TAIL_MESSAGES),
      recentTextTruncated: recentTruncated,
      hasImages,
      redacted,
      transcriptLimitReached,
    },
    compaction: {
      description:
        "Lossy structured summary of older context (request, files, errors, pending tasks, current work, next step) plus a few recent messages. Exact tool output and long file contents are compressed away. Other compaction hooks may differ.",
    },
  };
  return {
    state,
    conversationTokens: estimateConversationTokens(messages),
    checkpointText: JSON.stringify([lastUser, lastAssistant]),
    autoCoverage:
      omittedUsers === 0 && !recentTruncated && !redacted && !transcriptLimitReached && !hasImages,
  };
}
