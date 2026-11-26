/**
 * Rows-object replacements for the retired @earendil-works/pi-tui Text, Container and
 * Input components, plus the DynamicBorder and keyHint helpers newer host releases no
 * longer export. omp 19.2.1 replaced the pi-tui component API with a reactive one and
 * refuses to load an extension whose renderers return those old nodes; a renderer there
 * must return a `{ render(width): string[] }` rows object instead. Every class below
 * renders plain rows for `ctx.ui.custom` and `ctx.ui.setWidget`.
 */
import { keyText } from "@earendil-works/pi-coding-agent";

/** The rows-object shape `ctx.ui.custom` renderers and the widget callback accept. */
interface Rows {
  render(width: number): string[];
  invalidate(): void;
}

/** One line of text, optionally indented. `y` is accepted because the old Text took it. */
export class Text implements Rows {
  #text: string;
  readonly #indent: string;
  constructor(text = "", indent = 0, _y = 0) {
    this.#text = text;
    this.#indent = " ".repeat(Math.max(0, indent));
  }
  setText(text: string): void {
    this.#text = text;
  }
  invalidate(): void {}
  render(_width: number): string[] {
    return [this.#indent + this.#text];
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

/** Single-line editor: printable insertion, backspace, arrows, home/end, ctrl+k, ctrl+u. */
export class Input implements Rows {
  #value = "";
  #cursor = 0;
  focused = true;
  getValue(): string {
    return this.#value;
  }
  setValue(value: string): void {
    this.#value = value;
    this.#cursor = value.length;
  }
  invalidate(): void {}
  handleInput(data: string): void {
    switch (data) {
      case "\x1b[D":
        if (this.#cursor > 0) this.#cursor--;
        return;
      case "\x1b[C":
        if (this.#cursor < this.#value.length) this.#cursor++;
        return;
      case "\x1b[H":
      case "\x1bOH":
      case "\x01":
        this.#cursor = 0;
        return;
      case "\x1b[F":
      case "\x1bOF":
      case "\x05":
        this.#cursor = this.#value.length;
        return;
      case "\x7f":
      case "\b":
        if (this.#cursor > 0) {
          this.#value = this.#value.slice(0, this.#cursor - 1) + this.#value.slice(this.#cursor);
          this.#cursor--;
        }
        return;
      case "\x15":
        this.#value = this.#value.slice(this.#cursor);
        this.#cursor = 0;
        return;
      case "\x0b":
        this.#value = this.#value.slice(0, this.#cursor);
        return;
    }
    if (data.startsWith("\x1b")) return; // unhandled escape sequence
    for (const ch of data) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      this.#value = this.#value.slice(0, this.#cursor) + ch + this.#value.slice(this.#cursor);
      this.#cursor += ch.length;
    }
  }
  render(_width: number): string[] {
    const cursor = this.focused ? "\x1b[7m \x1b[0m" : "";
    return [this.#value.slice(0, this.#cursor) + cursor + this.#value.slice(this.#cursor)];
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
