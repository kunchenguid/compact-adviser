import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExtensionCommandContext,
  type KeybindingsManager,
  keyText,
} from "@earendil-works/pi-coding-agent";
import { promptSecret } from "../src/key-input.ts";
import { promptMinimum } from "../src/minimum-input.ts";
import { Container, DynamicBorder, Input, keyHint, Text, visibleWidth } from "../src/tui-compat.ts";

const HINT = "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";

const KEYS: Record<string, string[]> = {
  "tui.editor.cursorLeft": ["\x1b[D"],
  "tui.editor.cursorRight": ["\x1b[C"],
  "tui.editor.cursorLineStart": ["\x1b[H", "\x01", "\x1b[97;5u"],
  "tui.editor.cursorLineEnd": ["\x1b[F", "\x05"],
  "tui.editor.cursorWordLeft": ["\x1bb"],
  "tui.editor.cursorWordRight": ["\x1bf"],
  "tui.editor.deleteCharBackward": ["\x7f"],
  "tui.editor.deleteCharForward": ["\x1b[3~"],
  "tui.editor.deleteWordBackward": ["\x17"],
  "tui.editor.deleteWordForward": ["\x1bd"],
  "tui.editor.deleteToLineStart": ["\x15"],
  "tui.editor.deleteToLineEnd": ["\x0b", "\x1b[107;5u"],
};
const keybindings = { matches: (data: string, id: string) => KEYS[id]?.includes(data) ?? false };

function input(value: string, ...keys: string[]): Input {
  const field = new Input(keybindings);
  field.setValue(value);
  for (const key of keys) field.handleInput(key);
  return field;
}

test("Text pads each side, fills the width, and renders nothing for blank text", () => {
  const text = new Text("hello", 2);
  assert.deepEqual(text.render(12), ["  hello     "]);
  text.setText("bye");
  assert.deepEqual(text.render(7), ["  bye  "]);
  assert.deepEqual(new Text("plain").render(6), ["plain "]);
  assert.deepEqual(new Text("  ").render(6), []);
});

test("Text word-wraps so no row is wider than the viewport", () => {
  for (const width of [1, 5, 20, 40, 80, 81, 120]) {
    const rows = new Text(HINT).render(width);
    for (const row of rows) assert.equal(visibleWidth(row), width, `width ${width}`);
    if (width >= 10) assert.equal(rows.map((row) => row.trim()).join(" "), HINT);
  }
  assert.deepEqual(new Text(HINT).render(40), [
    "Compact adviser: work appears completed ",
    "or recorded. Run /compact to save       ",
    "tokens.                                 ",
  ]);
  assert.deepEqual(new Text("abcdefgh", 1).render(6), [" abcd ", " efgh "]);
});

test("Text reopens colour on every wrapped row and never counts it as width", () => {
  const rows = new Text("\x1b[33maaa bbb\x1b[39m").render(4);
  assert.deepEqual(rows, ["\x1b[33maaa\x1b[0m ", "\x1b[33mbbb\x1b[39m "]);
  for (const row of rows) assert.equal(visibleWidth(row), 4);
});

test("Container renders children in order and invalidates all of them", () => {
  let invalidated = 0;
  const child = { render: () => ["inner"], invalidate: () => invalidated++ };
  const box = new Container();
  box.addChild(new Text("first"));
  box.addChild(child);
  box.addChild(new DynamicBorder((str) => `<${str}>`));
  assert.deepEqual(box.render(5), ["first", "inner", "<─────>"]);
  box.invalidate();
  assert.equal(invalidated, 1);
});

test("DynamicBorder paints the full viewport width and never goes empty", () => {
  assert.deepEqual(new DynamicBorder().render(4), ["────"]);
  assert.deepEqual(new DynamicBorder((text) => `[${text}]`).render(0), ["[─]"]);
});

test("Input edits through the host keybindings, including Kitty-encoded keys", () => {
  assert.equal(input("abcd", "\x1b[F", "\x1b[D", "\x1b[D", "X").getValue(), "abXcd");
  assert.equal(input("abcd", "\x1b[F", "\x1b[D", "\x7f").getValue(), "abd");
  assert.equal(input("abcd", "\x1b[H", "\x1b[3~").getValue(), "bcd");
  assert.equal(input("abcd", "\x1b[F", "\x1b[D", "\x1b[D", "\x15").getValue(), "cd");
  assert.equal(input("abcd", "\x1b[C", "\x0b").getValue(), "a");
  assert.equal(input("abc", "\x1b[F", "\x1b[97;5u", "\x1b[107;5u").getValue(), "");
  assert.equal(input("one two", "\x1b[F", "\x17").getValue(), "one ");
  assert.equal(input("one two", "\x1bd").getValue(), " two");
  assert.equal(input("one two", "\x1b[F", "\x1bb", "X").getValue(), "one Xtwo");
  assert.equal(input("one two", "\x1bf", "X").getValue(), "oneX two");
  assert.equal(input("ab", "\x1b[3~", "\x1b[D", "\x7f").getValue(), "b");
  assert.equal(input("ab", "\x1b[15~", "\x1b[A", "\x09").getValue(), "ab");
});

test("Input inserts a bracketed paste as one line at the cursor", () => {
  assert.equal(input("", "\x1b[200~tsk_abc123\x1b[201~").getValue(), "tsk_abc123");
  assert.equal(input("ad", "\x1b[C", "\x1b[200~b\r\nc\x1b[201~").getValue(), "abcd");
  assert.equal(input("", "\x1b[200~a\tb\x1b[201~").getValue(), "a    b");
});

test("Input keeps its cursor across setValue, starting at the beginning", () => {
  assert.equal(input("12", "9").getValue(), "912");
  const field = input("", "a", "b", "c", "d", "\x1b[D");
  field.setValue("****");
  field.setValue("abcd");
  field.handleInput("X");
  assert.equal(field.getValue(), "abcXd");
  field.setValue("a");
  field.handleInput("Y");
  assert.equal(field.getValue(), "aY");
});

test("Input renders the prompt, inverts the cursor cell, and fills the width", () => {
  const field = input("abcd", "\x1b[C", "\x1b[C");
  assert.deepEqual(field.render(10), ["> ab\x1b[7mc\x1b[27md    "]);
  field.handleInput("\x1b[F");
  assert.deepEqual(field.render(8), ["> abcd\x1b[7m \x1b[27m "]);
  field.focused = false;
  assert.deepEqual(field.render(8), ["> abcd  "]);
  assert.deepEqual(new Input(keybindings).render(1), [">"]);
});

test("Input scrolls a long value so the row fits and the cursor stays visible", () => {
  const value = `${"x".repeat(30)}CURSOR${"y".repeat(30)}`;
  const field = input(value);
  for (let i = 0; i < 33; i++) field.handleInput("\x1b[C");
  for (const width of [3, 8, 20, 40, 200]) {
    const [row] = field.render(width);
    assert.equal(visibleWidth(row), width, `width ${width}`);
    assert.ok(row.includes("\x1b[7mS\x1b[27m"), `width ${width}`);
  }
  const end = input("*".repeat(100), "\x1b[F");
  assert.deepEqual(end.render(12), [`> ${"*".repeat(9)}\x1b[7m \x1b[27m`]);
});

test("keyHint styles the host key text and the description", () => {
  const calls: [string, string][] = [];
  const theme = {
    fg(color: string, text: string): string {
      calls.push([color, text]);
      return `${color}:${text}`;
    },
  };
  assert.equal(
    keyHint(theme, "tui.select.confirm", "save"),
    `dim:${keyText("tui.select.confirm")}muted: save`,
  );
  assert.deepEqual(calls[0][0], "dim");
  assert.deepEqual(calls[1], ["muted", " save"]);
});

// omp 19.2.1's KeybindingsManager: `matches` reads a decoded key event, so raw bytes never
// match there, and `matchesId` answers for a bare key id. Ids are omp's default chords.
const OMP_DEFAULTS: Record<string, string[]> = {
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.deleteCharBackward": ["backspace"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace", "ctrl+backspace"],
  "tui.editor.deleteWordForward": ["alt+delete", "alt+d", "ctrl+delete"],
  "tui.editor.deleteToLineStart": ["ctrl+u"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
};
const ompKeybindings = {
  matches: (event: unknown, id: string) =>
    typeof event === "object" &&
    event !== null &&
    (event as { kind?: string }).kind !== "release" &&
    (OMP_DEFAULTS[id]?.includes((event as { id: string }).id) ?? false),
  matchesId: (id: string, action: string) => OMP_DEFAULTS[action]?.includes(id) ?? false,
} as unknown as KeybindingsManager;

function ompInput(value: string, ...keys: string[]): Input {
  const field = new Input(ompKeybindings);
  field.setValue(value);
  for (const key of keys) field.handleInput(key);
  return field;
}

test("Input edits on a host whose keybindings match decoded key ids (omp)", () => {
  assert.equal(ompInput("40000", "\x01", "\x0b", "60000").getValue(), "60000");
  assert.equal(ompInput("40000", "\x1b[97;5u", "\x1b[107;5u", "7").getValue(), "7");
  assert.equal(ompInput("40000", "\x1b[27;5;97~", "\x1b[27;5;107~").getValue(), "");
  assert.equal(ompInput("abcd", "\x05", "\x1b[D", "\x1b[D", "X").getValue(), "abXcd");
  assert.equal(ompInput("abcd", "\x1bOF", "\x1bOD", "\x7f").getValue(), "abd");
  assert.equal(ompInput("abcd", "\x1b[1;1H", "\x1b[3~").getValue(), "bcd");
  assert.equal(ompInput("abcd", "\x1b[C", "\x04").getValue(), "acd");
  assert.equal(ompInput("one two", "\x1b[F", "\x1b\x7f").getValue(), "one ");
  assert.equal(ompInput("one two", "\x1b[F", "\x1b[1;5D", "X").getValue(), "one Xtwo");
  assert.equal(ompInput("one two", "\x1bd").getValue(), " two");
  assert.equal(ompInput("ab", "\x1b[F", "\x15").getValue(), "");
  assert.equal(ompInput("ab", "\x1b[97;5:3u", "\x1b[107;5:3u").getValue(), "ab");
});

interface PromptView {
  render(width: number): string[];
  handleInput(data: string): void;
}

function drive(
  prompt: (ctx: ExtensionCommandContext) => Promise<string | undefined>,
  ...keys: string[]
): Promise<string | undefined> {
  const theme = { fg: (_color: string, text: string) => text };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => PromptView) =>
        new Promise((resolve) => {
          const view = factory({ requestRender() {} }, theme, ompKeybindings, resolve);
          for (const key of keys) {
            view.render(60);
            view.handleInput(key);
          }
        }),
    },
  } as unknown as ExtensionCommandContext;
  return Promise.race([prompt(ctx), new Promise<string>((r) => setTimeout(() => r("open"), 50))]);
}

test("prompts save on Enter and cancel on Escape or Ctrl+C on an omp-style host", async () => {
  const minimum = (ctx: ExtensionCommandContext) => promptMinimum(ctx, 40000);
  assert.equal(await drive(minimum, "\r"), "40000");
  assert.equal(await drive(minimum, "\x01", "\x0b", "6", "0", "0", "0", "0", "\r"), "60000");
  assert.equal(await drive(minimum, "\x1b[13u"), "40000");
  assert.equal(await drive(minimum, "\x1b"), undefined);
  assert.equal(await drive(minimum, "\x03"), undefined);
  assert.equal(await drive(minimum, "\x1b[99;5u"), undefined);
  assert.equal(await drive(promptSecret, "a", "b", "d", "\x1b[D", "c", "\x05", "\r"), "abcd");
  assert.equal(await drive(promptSecret, "\x1b[200~tsk_abc\x1b[201~", "\r"), "tsk_abc");
  assert.equal(await drive(promptSecret, "x", "\x1b"), undefined);
  assert.equal(await drive(promptSecret, "x", "\x03"), undefined);
  assert.equal(await drive(promptSecret, "x"), "open");
});
