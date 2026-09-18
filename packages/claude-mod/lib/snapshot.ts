// The bounded, text-only judge input built from `$.session.messages()`, following the
// Pi extension's snapshot: user constraints, the recent tail, the prior summary, saved
// artifact names, and explicit coverage markers. Nothing here touches the engine.

export interface ToolUseLike {
  tool_use_id?: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: true;
}

export interface MessageLike {
  role: "user" | "assistant";
  text: string;
  toolUses: readonly ToolUseLike[];
  toolResults?: readonly { text: string; isError: boolean }[];
}

/** `$.session.messages()` answers at most this many; a full answer means older ones exist. */
export const MESSAGE_LIMIT = 4096;
/** Recent `$.session.messages()` entries considered for the TypeSafe/Jev snapshot, including assistant tool results. */
export const RECENT_TAIL_MESSAGES = 64;
/** Per-tool-result byte cap inside the recent tail; long results are middle-truncated. */
export const TOOL_RESULT_BUDGET = 512;
export const SUMMARY_PREFIX = "This session is being continued from a previous conversation";
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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

function toolPath(use: ToolUseLike): string | undefined {
  const path = use.input.file_path ?? use.input.notebook_path ?? use.input.path;
  return typeof path === "string" ? path : undefined;
}

/** A local estimate of the conversation's own tokens (about four characters per token). */
export function estimateConversationTokens(messages: readonly MessageLike[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.text.length;
    for (const use of m.toolUses)
      chars += JSON.stringify(use.input).length + (use.text?.length ?? 0);
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
      const path = toolPath(use);
      if (path && !use.isError && WRITE_TOOLS.has(use.tool) && !sensitivePath.test(path)) {
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
        const path = toolPath(use);
        let excerpt: string;
        if (path && sensitivePath.test(path)) {
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
  const transcriptLimitReached = messages.length >= MESSAGE_LIMIT;
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
      olderMessagesOmitted: Math.max(0, messages.length - RECENT_TAIL_MESSAGES),
      recentTextTruncated: recentTruncated,
      // Claude Code's transcript view carries text only; images cannot be detected here.
      hasImages: false,
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
    autoCoverage: omittedUsers === 0 && !recentTruncated && !redacted && !transcriptLimitReached,
  };
}
