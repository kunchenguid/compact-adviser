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
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
const segmenter = new Intl.Segmenter();

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 32 || (code >= 0x7f && code <= 0x9f);
}

function cells(grapheme: string): number {
  return WIDE.test(grapheme) ? 2 : 1;
}

/** Terminal columns `text` occupies, ignoring SGR colour codes. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const part of text.split(SGR)) {
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

const PROMPT = "> ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Single-line editor. Editing keys come from the host keybindings, so remapped keys and
 * Kitty-encoded keys work; a bracketed paste is inserted as one line.
 */
export class Input implements Rows {
  readonly #keys: Pick<KeybindingsManager, "matches">;
  #value = "";
  #cursor = 0;
  focused = true;
  constructor(keys: Pick<KeybindingsManager, "matches">) {
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
    return this.#value.slice(0, this.#cursor).search(/\S*\s*$/);
  }
  #wordEnd(): number {
    return this.#cursor + (/^\s*\S*/.exec(this.#value.slice(this.#cursor))?.[0].length ?? 0);
  }
  #delete(from: number, to: number): void {
    this.#value = this.#value.slice(0, from) + this.#value.slice(to);
    this.#cursor = from;
  }
  #insert(text: string): void {
    this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
    this.#cursor += text.length;
  }
  handleInput(data: string): void {
    const keys = this.#keys;
    const before = graphemes(this.#value.slice(0, this.#cursor)).at(-1)?.length ?? 0;
    const after = graphemes(this.#value.slice(this.#cursor))[0]?.length ?? 0;
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END))
      this.#insert(
        data
          .slice(PASTE_START.length, -PASTE_END.length)
          .replace(/[\r\n]/g, "")
          .replace(/\t/g, "    "),
      );
    else if (keys.matches(data, "tui.editor.cursorLeft")) this.#cursor -= before;
    else if (keys.matches(data, "tui.editor.cursorRight")) this.#cursor += after;
    else if (keys.matches(data, "tui.editor.cursorLineStart")) this.#cursor = 0;
    else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.#cursor = this.#value.length;
    else if (keys.matches(data, "tui.editor.cursorWordLeft")) this.#cursor = this.#wordStart();
    else if (keys.matches(data, "tui.editor.cursorWordRight")) this.#cursor = this.#wordEnd();
    else if (keys.matches(data, "tui.editor.deleteCharBackward"))
      this.#delete(this.#cursor - before, this.#cursor);
    else if (keys.matches(data, "tui.editor.deleteCharForward"))
      this.#delete(this.#cursor, this.#cursor + after);
    else if (keys.matches(data, "tui.editor.deleteWordBackward"))
      this.#delete(this.#wordStart(), this.#cursor);
    else if (keys.matches(data, "tui.editor.deleteWordForward"))
      this.#delete(this.#cursor, this.#wordEnd());
    else if (keys.matches(data, "tui.editor.deleteToLineStart")) this.#delete(0, this.#cursor);
    else if (keys.matches(data, "tui.editor.deleteToLineEnd"))
      this.#delete(this.#cursor, this.#value.length);
    else if (![...data].some(isControl)) this.#insert(data);
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
    const cursor = this.focused ? `\x1b[7m${at}\x1b[27m` : at;
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
