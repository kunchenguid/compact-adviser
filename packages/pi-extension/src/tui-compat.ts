/**
 * Rows-object replacements for the retired @earendil-works/pi-tui Text, Container and
 * Input components, plus the DynamicBorder and keyHint helpers newer host releases no
 * longer export. omp 19.2.1 replaced the pi-tui component API with a reactive one and
 * refuses to load an extension whose renderers return those old nodes; a renderer there
 * must return a `{ render(width): string[] }` rows object instead. Every class below
 * renders plain rows for `ctx.ui.custom` and `ctx.ui.setWidget`, and no row is ever wider
 * than the `width` it is given (pi throws on a row wider than the terminal).
 */
import { type KeybindingsManager, keyText } from "@earendil-works/pi-coding-agent";

/** The rows-object shape `ctx.ui.custom` renderers and the widget callback accept. */
interface Rows {
  render(width: number): string[];
  invalidate(): void;
}

const ESC = "\x1b";
const SGR = new RegExp(`(${ESC}\\[[0-9;:]*m)`);
const RESETS = ["\x1b[0m", "\x1b[m"];
/** Zero-width marker pi reads to place the hardware cursor (IME composition) and strips. */
const CURSOR_MARKER = "\x1b_pi:c\x07";
const segmenter = new Intl.Segmenter();

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 32 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Columns a grapheme may occupy. Anything at or above U+1100 is counted as wide: that
 * overcounts a few narrow scripts, but never undercounts a double-width character, so a
 * padded row can never exceed the width the host gave us.
 */
function cells(grapheme: string): number {
  return (grapheme.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
}

/** Terminal columns `text` occupies, ignoring SGR colour codes and the cursor marker. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const part of text.replaceAll(CURSOR_MARKER, "").split(SGR)) {
    if (!SGR.test(part)) for (const grapheme of graphemes(part)) width += cells(grapheme);
  }
  return width;
}

/** Word-wraps `text` to rows of at most `width` columns, reopening colour on each new row. */
function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  let style = "";
  const breakRow = () => {
    rows.push(style ? `${row}\x1b[0m` : row);
    row = style;
    rowWidth = 0;
  };
  for (const word of text.split(" ")) {
    if (rowWidth > 0) {
      if (rowWidth + 1 + visibleWidth(word) > width) breakRow();
      else {
        row += " ";
        rowWidth++;
      }
    }
    for (const part of word.split(SGR)) {
      if (SGR.test(part)) {
        row += part;
        style = RESETS.includes(part) ? "" : style + part;
        continue;
      }
      for (const grapheme of graphemes(part)) {
        if (rowWidth > 0 && rowWidth + cells(grapheme) > width) breakRow();
        row += grapheme;
        rowWidth += cells(grapheme);
      }
    }
  }
  rows.push(row);
  return rows;
}

/** Word-wrapped text with `padding` columns on each side, every row padded to the width. */
export class Text implements Rows {
  #text: string;
  readonly #padding: number;
  constructor(text = "", padding = 0) {
    this.#text = text;
    this.#padding = Math.max(0, padding);
  }
  setText(text: string): void {
    this.#text = text;
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (!this.#text.trim()) return [];
    const padding = Math.min(this.#padding, Math.max(0, Math.floor((width - 1) / 2)));
    const margin = " ".repeat(padding);
    return wrap(this.#text, Math.max(1, width - padding * 2)).map((line) => {
      const row = margin + line + margin;
      return row + " ".repeat(Math.max(0, width - visibleWidth(row)));
    });
  }
}

/** Children rendered in order; `invalidate` reaches every child. */
export class Container implements Rows {
  readonly #children: Rows[] = [];
  addChild(child: Rows): void {
    this.#children.push(child);
  }
  invalidate(): void {
    for (const child of this.#children) child.invalidate();
  }
  render(width: number): string[] {
    return this.#children.flatMap((child) => child.render(width));
  }
}

/** Horizontal rule that adapts to the viewport width (replaces DynamicBorder). */
export class DynamicBorder implements Rows {
  readonly #color: (str: string) => string;
  constructor(color: (str: string) => string = (str) => str) {
    this.#color = color;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [this.#color("─".repeat(Math.max(1, width)))];
  }
}

type Keybinding = Parameters<KeybindingsManager["matches"]>[1];
/** pi matches raw input bytes; omp matches only decoded key events, or bare ids via `matchesId`. */
type Keys = Pick<KeybindingsManager, "matches"> & {
  matchesId?(id: string, keybinding: Keybinding): boolean;
};

const MODIFIERS: [number, string][] = [
  [4, "ctrl+"],
  [2, "alt+"],
  [1, "shift+"],
  [8, "super+"],
];
const CSI_LETTERS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};
const CSI_TILDES: Record<string, string> = {
  1: "home",
  3: "delete",
  4: "end",
  7: "home",
  8: "end",
};
const CODEPOINTS: Record<number, string> = {
  8: "backspace",
  9: "tab",
  13: "enter",
  27: "escape",
  32: "space",
  127: "backspace",
};
const CSI_LETTER = new RegExp(`^${ESC}(?:\\[(?:1)?(?:;(\\d+)(?::(\\d+))?)?|O)([ABCDHF])$`);
const OTHER_KEYS = new RegExp(`^${ESC}\\[27;(\\d+);(\\d+)~$`);
const CSI_TILDE = new RegExp(`^${ESC}\\[(\\d+)(?:;(\\d+)(?::(\\d+))?)?~$`);
const CSI_U = new RegExp(
  `^${ESC}\\[(\\d+)(?::(\\d*)(?::\\d*)?)?(?:;(\\d+)(?::(\\d+))?)?(?:;[\\d:]*)?u$`,
);
/** Kitty keypad codepoints 57399-57416, as the keys they stand for (KP_ENTER is Enter). */
const KEYPAD = Array.from("0123456789./*-+\r=,", (ch) => ch.charCodeAt(0));
const KEYPAD_KEYS: Record<number, string> = {
  57417: "left",
  57418: "right",
  57419: "up",
  57420: "down",
  57423: "home",
  57424: "end",
  57426: "delete",
};

function unpad(cp: number): number {
  return KEYPAD[cp - 57399] ?? cp;
}

function isFunctional(cp: number): boolean {
  return cp >= 57344 && cp <= 63743;
}

/** Chord for a wire modifier value (1 + mask) and key; undefined for a release or hyper/meta. */
function chord(mods: string | undefined, event: string | undefined, key: string) {
  const mask = (Number(mods || 1) - 1) & ~(64 | 128);
  if (mask < 0 || mask & (16 | 32) || event === "3") return undefined;
  return MODIFIERS.map(([bit, name]) => (mask & bit ? name : "")).join("") + key;
}

function codepoint(code: number, mods: string | undefined, event: string | undefined) {
  const cp = unpad(code);
  const name =
    CODEPOINTS[cp] ??
    KEYPAD_KEYS[cp] ??
    (cp > 32 && cp <= 0x10ffff && !isFunctional(cp)
      ? String.fromCodePoint(cp).toLowerCase()
      : undefined);
  return name && chord(mods, event, name);
}

/**
 * The text a plain or Shift-only key types when the terminal escape-encodes it (Kitty CSI-u,
 * with the shifted key preferred and keypad keys as their characters, or modifyOtherKeys).
 */
function typed(data: string): string | undefined {
  const kitty = CSI_U.exec(data);
  const other = kitty ? null : OTHER_KEYS.exec(data);
  if (!kitty && !other) return undefined;
  const mask = (Number((kitty ? kitty[3] : other?.[1]) || 1) - 1) & ~(64 | 128);
  if (mask & ~1 || kitty?.[4] === "3") return undefined;
  const cp = unpad(Number(kitty ? (mask && kitty[2]) || kitty[1] : other?.[2]));
  return cp >= 32 && cp <= 0x10ffff && !isFunctional(cp) ? String.fromCodePoint(cp) : undefined;
}

/**
 * The host chord id (`ctrl+a`, `alt+left`, `enter`) of one key's raw bytes, in omp's format,
 * for the editing and confirm/cancel keys: legacy bytes, Alt chords, SS3, xterm CSI with
 * modifiers, modifyOtherKeys and the Kitty keyboard protocol. Undefined for anything else.
 */
function keyId(data: string): string | undefined {
  const code = data.length === 1 ? data.charCodeAt(0) : -1;
  if (code === 10) return "enter";
  if (code === 31) return "ctrl+-";
  if (code >= 1 && code <= 26 && !CODEPOINTS[code]) return `ctrl+${String.fromCharCode(code + 96)}`;
  if (code >= 0) return CODEPOINTS[code] ?? (code > 32 ? data : undefined);
  let match = CSI_LETTER.exec(data);
  if (match) return chord(match[1], match[2], CSI_LETTERS[match[3]]);
  match = OTHER_KEYS.exec(data);
  if (match) return codepoint(Number(match[2]), match[1], undefined);
  match = CSI_TILDE.exec(data);
  if (match) return CSI_TILDES[match[1]] && chord(match[2], match[3], CSI_TILDES[match[1]]);
  match = CSI_U.exec(data);
  if (match) return codepoint(Number(match[1]), match[3], match[4]);
  if (data.length !== 2 || data[0] !== ESC) return undefined;
  const inner = keyId(data[1]);
  return inner?.startsWith("ctrl+") ? `ctrl+alt+${inner.slice(5)}` : inner && `alt+${inner}`;
}

/** Whether `data` (one key's raw bytes) presses a chord the host binds to `keybinding`. */
export function matchesKey(keys: Keys, data: string, keybinding: Keybinding): boolean {
  if (keys.matches(data, keybinding)) return true;
  if (typeof keys.matchesId !== "function") return false;
  const id = keyId(data);
  return id !== undefined && keys.matchesId(id, keybinding);
}

const PUNCTUATION = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Cursor one word backward, stopping inside a word at its last punctuation character. */
function wordBackward(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const segments = [...wordSegmenter.segment(text.slice(0, cursor))];
  let at = cursor;
  while (segments.length > 0 && /^\s+$/.test(segments[segments.length - 1]?.segment ?? "")) {
    at -= segments.pop()?.segment.length ?? 0;
  }
  if (segments.length === 0) return at;
  const last = segments[segments.length - 1];
  if (last.isWordLike) {
    const matches = [...last.segment.matchAll(new RegExp(PUNCTUATION, "g"))];
    const tail = matches[matches.length - 1];
    at -= tail ? last.segment.length - (tail.index + tail[0].length) : last.segment.length;
  } else {
    while (
      segments.length > 0 &&
      !segments[segments.length - 1]?.isWordLike &&
      !/^\s+$/.test(segments[segments.length - 1]?.segment ?? "")
    ) {
      at -= segments.pop()?.segment.length ?? 0;
    }
  }
  return at;
}

/** Cursor one word forward, stopping inside a word at its first punctuation character. */
function wordForward(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length;
  const iterator = wordSegmenter.segment(text.slice(cursor))[Symbol.iterator]();
  let next = iterator.next();
  let at = cursor;
  while (!next.done && /^\s+$/.test(next.value.segment)) {
    at += next.value.segment.length;
    next = iterator.next();
  }
  if (next.done) return at;
  if (next.value.isWordLike) {
    at += PUNCTUATION.exec(next.value.segment)?.index ?? next.value.segment.length;
  } else {
    while (!next.done && !next.value.isWordLike && !/^\s+$/.test(next.value.segment)) {
      at += next.value.segment.length;
      next = iterator.next();
    }
  }
  return at;
}

const PROMPT = "> ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Single-line editor. Editing keys come from the host keybindings, so remapped keys and
 * Kitty-encoded keys work; a bracketed paste is inserted as one line. Deletions by word or
 * to a line end go to a kill ring for yank and yank-pop, and every edit can be undone.
 */
export class Input implements Rows {
  readonly #keys: Keys;
  #value = "";
  #cursor = 0;
  #last: "type" | "kill" | "yank" | undefined;
  readonly #undo: { value: string; cursor: number }[] = [];
  readonly #kills: string[] = [];
  focused = true;
  constructor(keys: Keys) {
    this.#keys = keys;
  }
  getValue(): string {
    return this.#value;
  }
  setValue(value: string): void {
    this.#value = value;
    this.#cursor = Math.min(this.#cursor, value.length);
  }
  invalidate(): void {}
  #wordStart(): number {
    return wordBackward(this.#value, this.#cursor);
  }
  #wordEnd(): number {
    return wordForward(this.#value, this.#cursor);
  }
  #splice(from: number, to: number, text = ""): void {
    this.#value = this.#value.slice(0, from) + text + this.#value.slice(to);
    this.#cursor = from + text.length;
  }
  #save(): void {
    this.#undo.push({ value: this.#value, cursor: this.#cursor });
  }
  #move(to: number): void {
    this.#cursor = to;
    this.#last = undefined;
  }
  #delete(from: number, to: number): void {
    this.#last = undefined;
    if (from >= to) return;
    this.#save();
    this.#splice(from, to);
  }
  #cut(from: number, to: number, backward: boolean): void {
    if (from >= to) return;
    this.#save();
    const text = this.#value.slice(from, to);
    const prior = this.#last === "kill" ? this.#kills.pop() : undefined;
    this.#kills.push(prior === undefined ? text : backward ? text + prior : prior + text);
    this.#splice(from, to);
    this.#last = "kill";
  }
  #type(text: string): void {
    if (this.#last !== "type" || /\s/.test(text)) this.#save();
    this.#splice(this.#cursor, this.#cursor, text);
    this.#last = "type";
  }
  #yank(pop: boolean): void {
    const prior = this.#kills.at(-1);
    if (prior === undefined || (pop && (this.#last !== "yank" || this.#kills.length < 2))) return;
    this.#save();
    const from = pop ? this.#cursor - prior.length : this.#cursor;
    if (pop) this.#kills.unshift(this.#kills.pop() ?? "");
    this.#splice(from, this.#cursor, this.#kills.at(-1));
    this.#last = "yank";
  }
  #restore(): void {
    const snapshot = this.#undo.pop();
    if (!snapshot) return;
    this.#value = snapshot.value;
    this.#cursor = snapshot.cursor;
    this.#last = undefined;
  }
  handleInput(data: string): void {
    const keys = (keybinding: Keybinding) => matchesKey(this.#keys, data, keybinding);
    const before = graphemes(this.#value.slice(0, this.#cursor)).at(-1)?.length ?? 0;
    const after = graphemes(this.#value.slice(this.#cursor))[0]?.length ?? 0;
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      this.#last = undefined;
      this.#save();
      this.#splice(
        this.#cursor,
        this.#cursor,
        data
          .slice(PASTE_START.length, -PASTE_END.length)
          .replace(/[\r\n]/g, "")
          .replace(/\t/g, "    "),
      );
    } else if (keys("tui.editor.undo")) this.#restore();
    else if (keys("tui.editor.cursorLeft")) this.#move(this.#cursor - before);
    else if (keys("tui.editor.cursorRight")) this.#move(this.#cursor + after);
    else if (keys("tui.editor.cursorLineStart")) this.#move(0);
    else if (keys("tui.editor.cursorLineEnd")) this.#move(this.#value.length);
    else if (keys("tui.editor.cursorWordLeft")) this.#move(this.#wordStart());
    else if (keys("tui.editor.cursorWordRight")) this.#move(this.#wordEnd());
    else if (keys("tui.editor.deleteCharBackward"))
      this.#delete(this.#cursor - before, this.#cursor);
    else if (keys("tui.editor.deleteCharForward")) this.#delete(this.#cursor, this.#cursor + after);
    else if (keys("tui.editor.deleteWordBackward"))
      this.#cut(this.#wordStart(), this.#cursor, true);
    else if (keys("tui.editor.deleteWordForward")) this.#cut(this.#cursor, this.#wordEnd(), false);
    else if (keys("tui.editor.deleteToLineStart")) this.#cut(0, this.#cursor, true);
    else if (keys("tui.editor.deleteToLineEnd")) this.#cut(this.#cursor, this.#value.length, false);
    else if (keys("tui.editor.yank")) this.#yank(false);
    else if (keys("tui.editor.yankPop")) this.#yank(true);
    else {
      const text = typed(data) ?? data;
      if (![...text].some(isControl)) this.#type(text);
    }
  }
  render(width: number): string[] {
    const room = width - PROMPT.length;
    if (room <= 0) return [PROMPT.slice(0, Math.max(0, width))];
    const before = graphemes(this.#value.slice(0, this.#cursor));
    const after = graphemes(this.#value.slice(this.#cursor));
    const at = after.shift() ?? " ";
    const span = (parts: string[]) => parts.reduce((sum, part) => sum + cells(part), 0);
    let used = span(before) + cells(at) + span(after);
    while (used > room && span(before) > Math.floor(room / 2)) used -= cells(before.shift() ?? "");
    while (used > room && after.length > 0) used -= cells(after.pop() ?? "");
    while (used > room && before.length > 0) used -= cells(before.shift() ?? "");
    const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m${at}\x1b[27m` : at;
    return [
      PROMPT + before.join("") + cursor + after.join("") + " ".repeat(Math.max(0, room - used)),
    ];
  }
}

interface ThemeLike {
  fg(color: string, text: string): string;
}

/** Styled key hint (replaces the keyHint helper newer hosts dropped; keys come from the host). */
export function keyHint(
  theme: ThemeLike,
  keybinding: Parameters<typeof keyText>[0],
  description: string,
): string {
  return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}
