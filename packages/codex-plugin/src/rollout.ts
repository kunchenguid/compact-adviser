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
  /**
   * The first token count recorded after the latest compaction, where Codex records the size of
   * the compacted history: the post-compaction baseline. Undefined with no compaction in the read
   * records or no count since.
   */
  tokensAfterCompaction: number | undefined;
  /** True when earlier records were dropped by the read window or message cap. */
  truncated: boolean;
}

export const EMPTY_ROLLOUT: Readonly<Rollout> = Object.freeze({
  originator: undefined,
  messages: [],
  tokens: undefined,
  window: undefined,
  tokensAfterCompaction: undefined,
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

/** Codex tool calls that carry a shell command line in their `command` argument. */
const SHELL_TOOLS = new Set(["shell", "local_shell", "unified_exec"]);

/** Interpreters whose `-c`/`-lc` argument is a shell line. */
const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** The object literal that opens at `open`, ended at its matching `}` and rewritten as JSON:
 *  keys written as bare identifiers are quoted, keys already written as JSON strings are kept as
 *  they are; `undefined` when the literal never closes. Nothing else is rewritten, so a literal
 *  beyond this shape stays undecodable and is dropped by the `JSON.parse` that follows. */
function objectLiteralJson(
  text: string,
  open: number,
): { json: string; close: number } | undefined {
  const stack: string[] = [];
  let json = "";
  let quote = false;
  let expectKey = false;
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      json += ch;
      if (ch === "\\") json += text.charAt(++i);
      else if (ch === '"') quote = false;
      continue;
    }
    if (expectKey && /[A-Za-z_$]/.test(ch)) {
      const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0] ?? "";
      json += /^\s*:/.test(text.slice(i + key.length)) ? JSON.stringify(key) : key;
      i += key.length - 1;
      expectKey = false;
      continue;
    }
    if (!/\s/.test(ch)) expectKey = false;
    json += ch;
    if (ch === '"') quote = true;
    else if (ch === "{" || ch === "[") {
      stack.push(ch);
      expectKey = ch === "{";
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return { json, close: i };
    } else if (ch === ",") expectKey = stack[stack.length - 1] === "{";
  }
  return undefined;
}

/** The shell line a Codex `exec` call carries. Codex records shell work as a `custom_tool_call`
 *  named `exec` whose input is a small JavaScript program, `const r = await tools.exec_command(
 *  {cmd: "...", ...}); text(r.output);` — the shell line sits in the object literal's `cmd`
 *  field, whose keys Codex writes either as bare identifiers or as JSON strings. The program is
 *  data: nothing is executed, and no general JavaScript is parsed. Only that exact call form is
 *  recognised, binding the same identifier in both places; any other program an `exec` call may
 *  carry, such as the `apply_patch` variant, yields nothing, like any other unrecognised input. */
function execProgramCommand(input: string): string {
  const opened = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.exec_command\(\s*\{/.exec(input);
  if (!opened) return "";
  const literal = objectLiteralJson(input, opened[0].length - 1);
  if (!literal) return "";
  // Only the output use of that same binding may follow the call: `); text(r.output);`.
  const used = /^\s*\)\s*;\s*text\(\s*([A-Za-z_$][\w$]*)\.output\s*\)\s*;?\s*$/.exec(
    input.slice(literal.close + 1),
  );
  if (!used || used[1] !== opened[1]) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(literal.json);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const command = (parsed as Record<string, unknown>).cmd;
  return typeof command === "string" && command !== "" ? command : "";
}

/** The shell command line a shell tool call carries: a string command as written, or the script a
 *  `bash -lc`/`-c` wrapper names. Argv words are already-split literals, never a shell line. */
function shellCommandText(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const command = (parsed as Record<string, unknown>).command;
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.filter((part): part is string => typeof part === "string");
  const flag = parts.findIndex((part, at) => {
    if (part !== "-c" && part !== "-lc") return false;
    const before = parts[at - 1] ?? "";
    return SHELL_BINARIES.has(before.slice(before.lastIndexOf("/") + 1));
  });
  if (flag === -1 || flag + 1 >= parts.length) return "";
  return parts[flag + 1] as string;
}

interface ShellWord {
  text: string;
  /** Some part came from quotes or an escape, so spaces are literal characters. */
  quoted: boolean;
}

type ShellToken =
  | { kind: "word"; word: ShellWord }
  | {
      kind: "op";
      text: string /** Digits attached directly before the operator: an fd. */;
      io?: string;
    };

/** A quote left open at the end of a line, resumed with the line that follows. */
interface ShellCarry {
  quote: string;
  word: string;
  tokens: ShellToken[];
}

const SHELL_OPERATORS = [
  "((",
  ";;&",
  ";;",
  ";&",
  "||",
  "&&",
  "|&",
  "<<-",
  "<<<",
  "<<",
  "<>",
  ">&",
  "<&",
  ">|",
  ">>",
  "<",
  ">",
  "|",
  "&",
  ";",
  "(",
  ")",
];
const SHELL_CONTROL_OPS = new Set([
  "((",
  ";;&",
  ";;",
  ";&",
  "||",
  "&&",
  "|&",
  "|",
  "&",
  ";",
  "(",
  ")",
]);
/** Words that may stand before a command name without hiding it. */
const SHELL_PREFIX_WORDS = new Set([
  "sudo",
  "command",
  "exec",
  "nohup",
  "time",
  "env",
  "nice",
  "stdbuf",
  "xargs",
]);
const SHELL_DEV_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"]);
/** Bash reserved words that may precede a command, so `[[` after them still opens a conditional. */
const SHELL_COND_INTRO_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "done",
  "fi",
  "{",
  "}",
  "!",
]);
/**
 * Bash reserved words that may stand directly before a command name, so `tee`
 * after one is still the command. `elif` is admitted because what follows it
 * begins a new command list, the same way `else` does. The remaining condition
 * openers (`if`, `while`, `until`) stay out as a deliberate conservative miss,
 * so writes introduced by them stay dropped.
 */
const SHELL_CMD_INTRO_WORDS = new Set(["then", "do", "else", "elif", "!", "{"]);

function shellOperatorAt(line: string, at: number): string | undefined {
  for (const op of SHELL_OPERATORS) if (line.startsWith(op, at)) return op;
  return undefined;
}

/**
 * Shell-lex one line into words and operators; quoted text stays literal.
 * A quote the line never closes is returned as `carry`, which the caller feeds
 * back with the next line so each line is lexed exactly once.
 */
function tokenizeShellLine(
  line: string,
  carry?: ShellCarry,
): { tokens: ShellToken[]; carry?: ShellCarry } {
  const tokens: ShellToken[] = carry ? carry.tokens : [];
  let word = "";
  let quoted = false;
  let hasWord = false;
  let open: string | undefined;
  let i = 0;
  const flush = () => {
    if (hasWord) tokens.push({ kind: "word", word: { text: word, quoted } });
    word = "";
    quoted = false;
    hasWord = false;
  };
  const readQuoted = (quote: string, from: number): number => {
    let j = from;
    while (j < line.length) {
      if (quote === '"' && line.charAt(j) === "\\" && j + 1 < line.length) {
        word += line.charAt(j + 1);
        j += 2;
        continue;
      }
      if (line.charAt(j) === quote) return j + 1;
      word += line.charAt(j);
      j++;
    }
    open = quote;
    return j;
  };
  if (carry) {
    word = `${carry.word}\n`;
    quoted = true;
    hasWord = true;
    i = readQuoted(carry.quote, 0);
  }
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === "'" || ch === '"') {
      i = readQuoted(ch, i + 1);
      quoted = true;
      hasWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      word += line.charAt(i + 1);
      quoted = true;
      hasWord = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    if (ch === "#" && !hasWord) break;
    const op = shellOperatorAt(line, i);
    if (op) {
      // Digits attached directly to a redirection are its fd, not a word.
      const io = hasWord && !SHELL_CONTROL_OPS.has(op) && /^\d+$/.test(word) ? word : undefined;
      if (io) hasWord = false;
      flush();
      tokens.push({ kind: "op", text: op, ...(io ? { io } : {}) });
      i += op.length;
      continue;
    }
    word += ch;
    hasWord = true;
    i++;
  }
  if (open) return { tokens, carry: { quote: open, word, tokens } };
  flush();
  return { tokens };
}

/** A word becomes a written path only when it confidently names one real file. */
function addShellWrittenPath(word: ShellWord, paths: string[]): void {
  const path = word.text;
  if (!path || path === "." || path === ".." || path.startsWith("-")) return;
  if (SHELL_DEV_PATHS.has(path) || path.startsWith("/dev/fd/")) return;
  // The shell would have expanded these; the literal text names no single file.
  if (/[$`*?{}[\]()<>;&'"|\\~]/.test(path)) return;
  if (!word.quoted && /\s/.test(path)) return;
  paths.push(path);
}

function shellTeeTargets(args: readonly ShellWord[], paths: string[]): void {
  for (const arg of args) {
    if (arg.text.startsWith("-")) continue;
    addShellWrittenPath(arg, paths);
  }
}

function shellSedTargets(args: readonly ShellWord[], paths: string[]): void {
  let inPlace = false;
  let scriptGiven = false;
  let suffixAmbiguous = false;
  let bareInPlace = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) break;
    const text = arg.text;
    const afterBare = bareInPlace;
    bareInPlace = false;
    if (afterBare && (text === "" || !text.startsWith("-"))) {
      suffixAmbiguous = text !== "";
      i++;
      continue;
    }
    if (text === "--") {
      i++;
      break;
    }
    if (!text.startsWith("-") || text === "-") break;
    if (!text.startsWith("--")) {
      let consumesNext = false;
      for (let k = 1; k < text.length; k++) {
        const letter = text[k];
        const rest = text.slice(k + 1);
        if (letter === "e" || letter === "f") {
          scriptGiven = true;
          consumesNext = rest === "";
          break;
        }
        if (letter === "i") {
          inPlace = true;
          bareInPlace = rest === "";
          break;
        }
        if (letter === "l") {
          consumesNext = rest === "";
          break;
        }
      }
      i += consumesNext && i + 1 < args.length ? 2 : 1;
      continue;
    }
    if (text === "--in-place") {
      inPlace = true;
    } else if (text.startsWith("--in-place=")) {
      inPlace = true;
    } else if (text === "--expression" || text === "--file") {
      scriptGiven = true;
      if (i + 1 < args.length) i++;
    } else if (text.startsWith("--expression=") || text.startsWith("--file=")) {
      scriptGiven = true;
    } else if (text === "--line-length") {
      if (i + 1 < args.length) i++;
    }
    i++;
  }
  if (!inPlace) return;
  // A non-empty word after a bare -i is a BSD suffix or a GNU script; without -e/-f, undecidable.
  if (suffixAmbiguous && !scriptGiven) return;
  const operands = args.slice(i).filter((arg) => arg.text !== "");
  // Without -e/-f the first operand is the sed script; with them, all are files.
  const files = scriptGiven ? operands : operands.slice(1);
  for (const file of files) addShellWrittenPath(file, paths);
}

function matchShellWriters(words: readonly ShellWord[], paths: string[]): void {
  let start = 0;
  while (start < words.length) {
    const word = words[start];
    if (!word) break;
    if (
      SHELL_PREFIX_WORDS.has(word.text) ||
      SHELL_CMD_INTRO_WORDS.has(word.text) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)
    ) {
      start++;
      continue;
    }
    break;
  }
  const first = words[start]?.text;
  if (first === "tee") shellTeeTargets(words.slice(start + 1), paths);
  else if (first === "sed") shellSedTargets(words.slice(start + 1), paths);
}

function collectShellWrittenPaths(
  tokens: readonly ShellToken[],
  paths: string[],
  heredocs: { delimiter: string; dashed: boolean }[],
): void {
  let segment: ShellWord[] = [];
  let cond = false;
  let arith = false;
  let arithDepth = 0;
  let suppress = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) break;
    if (token.kind === "word") {
      const text = token.word.text;
      if (
        !cond &&
        text === "[[" &&
        (segment.length === 0 || segment.every((w) => SHELL_COND_INTRO_WORDS.has(w.text)))
      ) {
        cond = true;
        suppress = true;
      } else if (cond && text === "]]") {
        cond = false;
      }
      segment.push(token.word);
      continue;
    }
    if (SHELL_CONTROL_OPS.has(token.text)) {
      if (token.text === "((" && !arith) arith = true;
      else if (token.text === "(" && arith) arithDepth++;
      else if (token.text === ")" && arith) {
        if (arithDepth > 0) arithDepth--;
        else arith = false;
      }
      if (!suppress) matchShellWriters(segment, paths);
      segment = [];
      suppress = cond || arith;
      continue;
    }
    const target = tokens[i + 1];
    const targetWord = target?.kind === "word" ? target.word : undefined;
    if (token.text === "<<" || token.text === "<<-") {
      if (targetWord) {
        if (targetWord.text)
          heredocs.push({ delimiter: targetWord.text, dashed: token.text === "<<-" });
        i++;
      }
      continue;
    }
    if (
      !cond &&
      !arith &&
      (token.text === ">" || token.text === ">>" || token.text === ">|") &&
      (!token.io || token.io === "1") &&
      targetWord
    ) {
      addShellWrittenPath(targetWord, paths);
    }
    if (targetWord) i++;
  }
  if (!suppress) matchShellWriters(segment, paths);
}

/**
 * The files one shell command line writes through output redirection (`>`,
 * `>>` and `>|`), `tee`, or in-place `sed`. The command text is data — nothing is
 * executed or expanded. Parsing is conservative: heredoc bodies never yield a
 * path, `>` and `<` inside `[[ ]]` conditionals and `(( ))` arithmetic are
 * comparisons rather than redirections, a word the shell would have expanded or
 * globbed names no file, and any construct the parser cannot read with
 * confidence yields nothing.
 *
 * Copied verbatim into every host package; lockstep.test.ts keeps them in step.
 */
export function shellWrittenPaths(command: string): string[] {
  const paths: string[] = [];
  const heredocs: { delimiter: string; dashed: boolean }[] = [];
  let carry: ShellCarry | undefined;
  for (const line of command.split("\n")) {
    const pending = heredocs[0];
    if (pending) {
      const candidate = pending.dashed ? line.replace(/^\t+/, "") : line;
      if (candidate === pending.delimiter) heredocs.shift();
      continue;
    }
    const lexed = tokenizeShellLine(line, carry);
    carry = lexed.carry;
    if (carry) continue;
    collectShellWrittenPaths(lexed.tokens, paths, heredocs);
  }
  return paths;
}

function toolPaths(name: string, input: string): { written: string[]; removed: string[] } {
  if (name === "apply_patch") return patchChanges(input);
  if (name === "exec") {
    const command = execProgramCommand(input);
    return { written: command ? shellWrittenPaths(command) : [], removed: [] };
  }
  if (SHELL_TOOLS.has(name)) {
    const command = shellCommandText(input);
    return { written: command ? shellWrittenPaths(command) : [], removed: [] };
  }
  return { written: argumentPaths(input), removed: [] };
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
  let compacted = false;
  let tokensAfterCompaction: number | undefined;

  for (const record of records) {
    const entry = record as { type?: unknown; payload?: unknown } | null;
    if (entry?.type === "compacted") {
      applyCompacted(entry.payload, messages, pending);
      compacted = true;
      tokensAfterCompaction = undefined;
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
      if (typeof last?.total_tokens === "number") {
        tokens = last.total_tokens;
        if (compacted && tokensAfterCompaction === undefined) tokensAfterCompaction = tokens;
      }
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
    tokensAfterCompaction,
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
