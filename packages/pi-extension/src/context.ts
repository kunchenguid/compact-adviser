import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildSessionContext,
  type ExtensionContext,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";

/** Recent assistant and toolResult messages considered for the Jev snapshot. */
export const RECENT_TAIL_MESSAGES = 64;
/** Per-tool-result byte cap inside the recent tail; long results are middle-truncated. */
export const TOOL_RESULT_BUDGET = 512;

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  return {
    text: Buffer.from(text)
      .subarray(0, Math.max(0, limit - 3))
      .toString("utf8"),
    truncated: true,
  };
}

function truncatedMarker(omitted: number): string {
  return `...[truncated ${omitted} bytes]...`;
}

/** Keep a head and tail slice so one long tool dump cannot hide its start or end. */
export function clipMiddle(text: string, limit: number): { text: string; truncated: boolean } {
  const raw = Buffer.from(text);
  if (raw.byteLength <= limit) return { text, truncated: false };
  if (limit <= 0) return { text: "", truncated: true };
  let omitted = raw.byteLength;
  let head = 0;
  let tail = 0;
  for (let i = 0; i < 5; i++) {
    const markerBytes = Buffer.byteLength(truncatedMarker(omitted));
    if (markerBytes >= limit) return clip(text, limit);
    const keep = limit - markerBytes;
    head = Math.ceil(keep / 2);
    tail = Math.floor(keep / 2);
    omitted = Math.max(0, raw.byteLength - head - tail);
  }
  const marker = truncatedMarker(omitted);
  return {
    text: Buffer.concat([
      raw.subarray(0, head),
      Buffer.from(marker),
      raw.subarray(raw.byteLength - tail),
    ]).toString("utf8"),
    truncated: true,
  };
}
const sensitivePath =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|auth\.json|id_(?:rsa|ed25519)|[^\\/]*\.(?:pem|key))$/i;

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isOwnedSecretField(key: string): boolean {
  return key === "openrouterApiKey" || key.endsWith(".openrouterApiKey");
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
  if (!text.includes("openrouterApiKey")) return { text, redacted: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    const walked = redactOwnedSecretFields(parsed);
    if (walked.redacted) return { text: JSON.stringify(walked.value), redacted: true };
  } catch {
    // Clipped or non-JSON tool output still goes through the field regex below.
  }
  const clean = text
    .replace(/("(?:[^"\\]*\.)?openrouterApiKey")\s*:\s*"(?:\\.|[^"\\])*"/g, '$1:"[REDACTED]"')
    .replace(/\b(openrouterApiKey)\s*[=:]\s*["']?[^\s"',}]+/g, "$1=[REDACTED]");
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

export function snapshot(ctx: ExtensionContext, secrets: readonly (string | undefined)[] = []) {
  const messages = buildSessionContext(ctx.sessionManager.buildContextEntries()).messages;
  const conversationTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  const paths = new Map<string, { path: string; name: string }>();
  const artifacts = new Set<string>();
  let hasImages = false,
    redacted = false,
    unknownContext = false,
    omittedUsers = 0,
    recentTruncated = false;
  let userBudget = 8000,
    tailBudget = 14000;
  const users: { role: string; text: string }[] = [];
  const recent: { role: string; text: string; tool?: string; error?: boolean }[] = [];
  let summary = "";
  for (const m of messages) {
    if (m.role === "assistant")
      for (const c of m.content)
        if (c.type === "toolCall" && typeof c.arguments.path === "string")
          paths.set(c.id, { path: c.arguments.path, name: c.name });
    if (m.role === "toolResult") {
      const p = paths.get(m.toolCallId);
      if (p && !m.isError && ["write", "edit"].includes(p.name) && !sensitivePath.test(p.path)) {
        const full = resolve(ctx.cwd, p.path);
        if (fileExists(full)) artifacts.add(p.path);
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    let raw = "";
    if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
      if (typeof m.content === "string") raw = m.content;
      else {
        hasImages ||= m.content.some((c) => c.type === "image");
        raw = m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      const toolPathName = m.role === "toolResult" ? (paths.get(m.toolCallId)?.path ?? "") : "";
      if (m.role === "toolResult" && sensitivePath.test(toolPathName)) {
        raw = "[Sensitive file content excluded]";
        redacted = true;
      }
    } else if (m.role === "compactionSummary" || m.role === "branchSummary") {
      if (!summary) {
        const s = sanitizeText(m.summary, secrets);
        summary = clip(s.text, 1500).text;
        redacted ||= s.redacted;
      }
      continue;
    } else {
      unknownContext = true;
      continue;
    }
    const cleaned = sanitizeText(raw, secrets);
    redacted ||= cleaned.redacted;
    if (m.role === "user") {
      const part = clip(cleaned.text, userBudget);
      if (part.truncated) omittedUsers++;
      if (part.text) users.unshift({ role: "user", text: part.text });
      userBudget = Math.max(0, userBudget - Buffer.byteLength(part.text));
    } else if (i >= messages.length - RECENT_TAIL_MESSAGES) {
      const part =
        m.role === "toolResult"
          ? clipMiddle(cleaned.text, Math.min(tailBudget, TOOL_RESULT_BUDGET))
          : clip(cleaned.text, Math.min(tailBudget, 8000));
      recentTruncated ||= part.truncated;
      tailBudget = Math.max(0, tailBudget - Buffer.byteLength(part.text));
      recent.unshift({
        role: m.role,
        text: part.text,
        ...(m.role === "toolResult" ? { tool: m.toolName, error: m.isError } : {}),
      });
    }
  }
  const persistent = ctx.sessionManager.getSessionFile();
  const recoveryAvailable = !!persistent && fileExists(persistent);
  const state = {
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
      hasImages,
      redacted,
      unknownContext,
      transcriptRecoverable: recoveryAvailable,
    },
    compaction: {
      description:
        "Lossy summary of older context; default recent tail about 20k tokens; tool results truncated to 2000 characters for summarization. Other compaction hooks/settings may differ.",
    },
  };
  const lastAssistant = recent.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  const checkpointKey = createHash("sha256")
    .update(JSON.stringify([users.at(-1)?.text, lastAssistant]))
    .digest("hex");
  return {
    state,
    conversationTokens,
    checkpointKey,
    autoCoverage:
      omittedUsers === 0 &&
      !recentTruncated &&
      !hasImages &&
      !redacted &&
      !unknownContext &&
      recoveryAvailable,
  };
}
