import assert from "node:assert/strict";
import { test } from "node:test";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Container, DynamicBorder, Input, keyHint, Text } from "../src/tui-compat.ts";

test("Text renders one indented row and follows setText", () => {
  const text = new Text("hello", 2, 0);
  assert.deepEqual(text.render(40), ["  hello"]);
  text.setText("bye");
  assert.deepEqual(text.render(10), ["  bye"]);
  assert.deepEqual(new Text("plain").render(10), ["plain"]);
});

test("Container renders children in order and invalidates all of them", () => {
  let invalidated = 0;
  const child = { render: () => ["inner"], invalidate: () => invalidated++ };
  const box = new Container();
  box.addChild(new Text("first"));
  box.addChild(child);
  box.addChild(new DynamicBorder((str) => `<${str}>`));
  assert.deepEqual(box.render(3), ["first", "inner", "<───>"]);
  box.invalidate();
  assert.equal(invalidated, 1);
});

test("DynamicBorder paints the full viewport width and never goes empty", () => {
  assert.deepEqual(new DynamicBorder().render(4), ["────"]);
  assert.deepEqual(new DynamicBorder((text) => `[${text}]`).render(0), ["[─]"]);
});

test("Input edits at the cursor and shows the cursor only while focused", () => {
  const input = new Input();
  input.setValue("abcd");
  input.handleInput("\x1b[D");
  input.handleInput("\x1b[D");
  input.handleInput("X");
  assert.equal(input.getValue(), "abXcd");
  input.handleInput("\x7f");
  assert.equal(input.getValue(), "abcd");
  input.handleInput("\x01");
  input.handleInput("\x1b[3~");
  assert.equal(input.getValue(), "abcd");
  input.handleInput("\x15");
  assert.equal(input.getValue(), "abcd");
  input.handleInput("\x1b[H");
  input.handleInput("\x1b[F");
  input.handleInput("Z");
  assert.equal(input.getValue(), "abcdZ");

  assert.equal(input.render(80)[0], "abcdZ\x1b[7m \x1b[0m");
  input.focused = false;
  assert.equal(input.render(80)[0], "abcdZ");

  const killed = new Input();
  killed.setValue("abc");
  killed.handleInput("\x01");
  killed.handleInput("\x0b");
  assert.equal(killed.getValue(), "");

  const fresh = new Input();
  fresh.setValue("ab");
  fresh.handleInput("\x1b[D");
  assert.equal(fresh.render(80)[0], "a\x1b[7m \x1b[0mb");
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
