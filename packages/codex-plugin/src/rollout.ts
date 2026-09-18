// Reading the Codex rollout transcript at the hook payload's `transcript_path`.
//
// Codex documents this file as "not a stable interface for hooks"; it can change without
// notice. So every field is optional here: an unreadable or unrecognised record is skipped,
// unknown usage is returned as NaN (which `floorFor` turns into the strictest hint floor),
// and an empty transcript simply yields nothing to judge. Nothing in this file throws.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { MessageLike, ToolUseLike } from "./snapshot.ts";
import { MESSAGE_LIMIT, SUMMARY_PREFIX } from "./snapshot.ts";

/** The tail of the rollout read into memory. A long session's file is far larger than the
 *  snapshot's own byte budgets, so only the end of it can matter. */
export const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024;
/** Enough of the file's start to hold its `session_meta` line. */
const HEAD_BYTES = 256 * 1024;

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/** Codex injects its own context as `user` records; these are the host's, not the person's. */
const INJECTED_USER_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<skills_instructions>",
  "<plugins_instructions>",
  "<apps_instructions>",
];

export interface Rollout {
  /** How this session was started: `codex-tui` is the interactive TUI. */
  originator: string | undefined;
  messages: MessageLike[];
  /** Tokens the last model request occupied, or undefined when no usage record was found. */
  tokens: number | undefined;
  /** The active model's context window, or undefined when it was not recorded. */
  window: number | undefined;
  /** True when earlier records were dropped by the read window or message cap. */
  truncated: boolean;
}

export const EMPTY_ROLLOUT: Readonly<Rollout> = Object.freeze({
  originator: undefined,
  messages: [],
  tokens: undefined,
  window: undefined,
  truncated: false,
});

/** Context usage as a fraction of the window, or NaN when either number is unusable. */
export function usageFraction(rollout: Pick<Rollout, "tokens" | "window">): number {
  const { tokens, window } = rollout;
  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    typeof window !== "number" ||
    !Number.isFinite(window) ||
    window <= 0
  ) {
    return Number.NaN;
  }
  return tokens / window;
}

/** Reads the first line, and the last `MAX_ROLLOUT_BYTES`, dropping a partial line between. */
function readHeadAndTail(path: string): { head: string; tail: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - MAX_ROLLOUT_BYTES);
    const tail = readRange(fd, start, size - start);
    if (start === 0) return { head: "", tail, truncated: false };
    const newline = tail.indexOf("\n");
    // The session header is the file's first line, which the tail window may have cut away.
    return {
      head: firstLine(readRange(fd, 0, HEAD_BYTES)),
      tail: newline === -1 ? "" : tail.slice(newline + 1),
      truncated: true,
    };
  } finally {
    closeSync(fd);
  }
}

function readRange(fd: number, start: number, length: number): string {
  if (length <= 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, start + read);
    if (n <= 0) break;
    read += n;
  }
  return buffer.subarray(0, read).toString("utf8");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const type = (part as { type?: unknown } | null)?.type;
    return type === "input_image" || type === "output_image" || type === "image";
  });
}

/** Written and removed paths in an `apply_patch` body, including move sources as removed. */
export function patchChanges(input: string): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  let pending: string | undefined;
  for (const line of input.split(/\r?\n/)) {
    const add = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line);
    const update = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(line);
    const del = /^\*\*\* Delete File:\s*(.+?)\s*$/.exec(line);
    const move = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (add?.[1]) {
      pending = add[1];
      written.push(add[1]);
      continue;
    }
    if (update?.[1]) {
      pending = update[1];
      written.push(update[1]);
      continue;
    }
    if (del?.[1]) {
      pending = undefined;
      removed.push(del[1]);
      continue;
    }
    if (move?.[1]) {
      if (pending !== undefined) {
        const idx = written.lastIndexOf(pending);
        if (idx !== -1) written.splice(idx, 1);
        removed.push(pending);
        pending = undefined;
      }
      written.push(move[1]);
    }
  }
  return { written, removed };
}

/** The file paths an `apply_patch` body writes: added, updated, and move destinations. */
export function patchPaths(input: string): string[] {
  return patchChanges(input).written;
}

/** The file paths a JSON tool-argument object names, for the tools that write one file. */
function argumentPaths(argumentsJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const candidate = record.file_path ?? record.path;
  return typeof candidate === "string" && candidate !== "" ? [candidate] : [];
}

function toolPaths(name: string, input: string): { written: string[]; removed: string[] } {
  return name === "apply_patch"
    ? patchChanges(input)
    : { written: argumentPaths(input), removed: [] };
}

function processExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return processExitCode(JSON.parse(trimmed));
      } catch {}
    }
    const match = /^Process exited with code (-?\d+)\b/m.exec(trimmed);
    return match ? Number(match[1]) : undefined;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      const code = processExitCode((part as { text?: unknown } | null)?.text);
      if (code !== undefined) return code;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const meta = record.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const code = processExitCode((meta as Record<string, unknown>).exit_code);
      if (code !== undefined) return code;
    }
    return processExitCode(record.exit_code);
  }
  return undefined;
}

/** True when the tool output records a failure rather than a result. */
function isFailure(output: unknown): boolean {
  const code = processExitCode(output);
  if (code !== undefined) return code !== 0;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  return record.success === false || record.status === "failed" || record.status === "error";
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return textOf(output);
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    return textOf(record.content ?? record.output ?? record.text);
  }
  return "";
}

/**
 * Maps the rollout's `response_item` records onto the shape the snapshot consumes.
 *
 * A tool call becomes an assistant entry of its own carrying one tool use, so a call and its
 * result stay adjacent in the recent tail even though the rollout writes them as separate
 * records. A `compaction` record becomes the prior summary the snapshot already knows how to
 * read, which is how the same field is filled on the other two hosts.
 */
function consumeResponseItem(
  payload: Record<string, unknown>,
  messages: MessageLike[],
  pending: Map<string, ToolUseLike>,
): void {
  if (payload.type === "message") {
    const text = textOf(payload.content).trim();
    const hasImages = contentHasImage(payload.content);
    if (!text && !hasImages) return;
    const image = hasImages ? { hasImages: true as const } : {};
    if (payload.role === "assistant") {
      messages.push({ role: "assistant", text, toolUses: [], ...image });
    } else if (payload.role === "user") {
      if (text && INJECTED_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return;
      messages.push({ role: "user", text, toolUses: [], ...image });
    }
    return;
  }

  if (payload.type === "compaction") {
    const text = textOf(payload.content ?? payload.summary ?? payload.text).trim();
    if (text) messages.push({ role: "user", text: `${SUMMARY_PREFIX}: ${text}`, toolUses: [] });
    return;
  }

  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const raw = payload.type === "custom_tool_call" ? payload.input : payload.arguments;
    const input = typeof raw === "string" ? raw : "";
    const changes = toolPaths(name, input);
    const use: ToolUseLike = {
      tool: name,
      paths: changes.written,
      ...(changes.removed.length > 0 ? { removedPaths: changes.removed } : {}),
    };
    messages.push({ role: "assistant", text: "", toolUses: [use] });
    if (typeof payload.call_id === "string") pending.set(payload.call_id, use);
    return;
  }

  if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
    const use = typeof payload.call_id === "string" ? pending.get(payload.call_id) : undefined;
    if (!use) return;
    pending.delete(payload.call_id as string);
    use.text = outputText(payload.output);
    if (isFailure(payload.output)) use.isError = true;
  }
}

function applyCompacted(
  payload: unknown,
  messages: MessageLike[],
  pending: Map<string, ToolUseLike>,
): void {
  messages.length = 0;
  pending.clear();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const history = Array.isArray(record.replacement_history) ? record.replacement_history : [];
  for (const item of history) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    consumeResponseItem(item as Record<string, unknown>, messages, pending);
  }
  const summary = typeof record.message === "string" ? record.message.trim() : "";
  if (summary && !messages.some((m) => m.role === "user" && m.text.startsWith(SUMMARY_PREFIX))) {
    messages.push({
      role: "user",
      text: summary.startsWith(SUMMARY_PREFIX) ? summary : `${SUMMARY_PREFIX}: ${summary}`,
      toolUses: [],
    });
  }
}

export function mapRecords(records: readonly unknown[]): Rollout {
  const messages: MessageLike[] = [];
  const pending = new Map<string, ToolUseLike>();
  let originator: string | undefined;
  let tokens: number | undefined;
  let window: number | undefined;

  for (const record of records) {
    const entry = record as { type?: unknown; payload?: unknown } | null;
    if (entry?.type === "compacted") {
      applyCompacted(entry.payload, messages, pending);
      continue;
    }

    const payload = (entry?.payload ?? null) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") continue;

    if (entry?.type === "session_meta") {
      if (typeof payload.originator === "string") originator = payload.originator;
      continue;
    }

    if (entry?.type === "event_msg" && payload.type === "token_count") {
      const info = (payload.info ?? null) as Record<string, unknown> | null;
      const last = (info?.last_token_usage ?? null) as Record<string, unknown> | null;
      if (typeof last?.total_tokens === "number") tokens = last.total_tokens;
      if (typeof info?.model_context_window === "number") window = info.model_context_window;
      continue;
    }

    if (entry?.type !== "response_item") continue;
    consumeResponseItem(payload, messages, pending);
  }

  const truncated = messages.length > MESSAGE_LIMIT;
  return {
    originator,
    messages: messages.slice(-MESSAGE_LIMIT),
    tokens,
    window,
    truncated,
  };
}

/** Reads and maps the rollout; an unreadable transcript yields the empty rollout. */
export function readRollout(path: string): Rollout {
  let parts: { head: string; tail: string; truncated: boolean };
  try {
    parts = readHeadAndTail(path);
  } catch {
    return { ...EMPTY_ROLLOUT, messages: [] };
  }
  const records: unknown[] = [];
  for (const line of `${parts.head}\n${parts.tail}`.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // One unreadable record does not invalidate the rest of the transcript.
    }
  }
  const mapped = mapRecords(records);
  return { ...mapped, truncated: mapped.truncated || parts.truncated };
}
