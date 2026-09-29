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
/** Claude Code's shell tool, whose `command` input may write files itself. */
const SHELL_TOOLS = new Set(["Bash"]);

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

/** The product's saved-key settings fields, one per judge provider. */
const OWNED_SECRET_FIELDS = ["typesafeApiKey", "aiGatewayApiKey"];

function isOwnedSecretField(key: string): boolean {
  return OWNED_SECRET_FIELDS.some((field) => key === field || key.endsWith(`.${field}`));
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
  if (!OWNED_SECRET_FIELDS.some((field) => text.includes(field))) return { text, redacted: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    const walked = redactOwnedSecretFields(parsed);
    if (walked.redacted) return { text: JSON.stringify(walked.value), redacted: true };
  } catch {
    // Clipped or non-JSON tool output still goes through the field regex below.
  }
  const clean = text
    .replace(
      /("(?:[^"\\]*\.)?(?:typesafeApiKey|aiGatewayApiKey)")\s*:\s*"(?:\\.|[^"\\])*"/g,
      '$1:"[REDACTED]"',
    )
    .replace(/\b(typesafeApiKey|aiGatewayApiKey)\s*[=:]\s*["']?[^\s"',}]+/g, "$1=[REDACTED]");
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
      if (use.isError) continue;
      const path = toolPath(use);
      if (path && WRITE_TOOLS.has(use.tool) && !sensitivePath.test(path)) {
        artifacts.delete(path);
        artifacts.add(path);
      }
      const command =
        SHELL_TOOLS.has(use.tool) && typeof use.input.command === "string"
          ? use.input.command
          : undefined;
      for (const written of command ? shellWrittenPaths(command) : []) {
        if (!sensitivePath.test(written)) {
          artifacts.delete(written);
          artifacts.add(written);
        }
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
