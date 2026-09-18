import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  type CompactOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { installAdviser } from "../src/adviser.ts";
import { ConfigStore } from "../src/config.ts";
import { RECENT_TAIL_MESSAGES } from "../src/context.ts";
import { type Judgment, parseJudgment } from "../src/judge.ts";

export function temp(t: TestContext): string {
  const root = join(process.cwd(), ".test-tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export const apiResponse = (finished = 0.995, handsOn = 0.99) => ({
  model: "jev-test",
  usage: { input_tokens: 2000, output_tokens: 60 },
  answers: {
    done: {
      type: "choice",
      choice: finished >= 0.5 ? "finished" : "not_finished",
      probabilities: {
        finished,
        not_finished: Number((1 - finished).toFixed(6)),
        unclear: 0,
      },
      confidence: Math.abs(finished - 0.5) * 2,
    },
    shape: {
      type: "choice",
      choice: handsOn >= 0.5 ? "hands_on" : "coordinating",
      probabilities: {
        hands_on: handsOn,
        coordinating: Number((1 - handsOn).toFixed(6)),
        unclear: 0,
      },
      confidence: Math.abs(handsOn - 0.5) * 2,
    },
  },
});
export function success(): Judgment {
  return parseJudgment(apiResponse());
}
export function assistant(
  text: string,
  stopReason: "stop" | "toolUse" | "error" | "aborted" | "length" = "stop",
) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions" as const,
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 40000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 40010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}
export function toolResult(text: string, toolName = "bash", toolCallId = "tool-1") {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: Date.now(),
  };
}
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
export function harness(
  t: TestContext,
  evaluate: (state: unknown, key: string, signal: AbortSignal) => Promise<Judgment> = async () =>
    success(),
) {
  initTheme("dark", false);
  const dir = temp(t),
    store = new ConfigStore(dir);
  const sm = SessionManager.create(dir, join(dir, "sessions"));
  sm.appendMessage({
    role: "user",
    content: "Finish and save the report; next work can read it.",
    timestamp: 1,
  });
  sm.appendMessage(assistant("Earlier exploration. ".repeat(6000)));
  for (let i = 0; i < RECENT_TAIL_MESSAGES; i++)
    sm.appendMessage(assistant(`Exploration checkpoint ${i}`));
  sm.appendMessage(assistant("Report saved; the phase is complete. Next: read the saved report."));
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const notifications: string[] = [],
    widgets: (string[] | undefined)[] = [],
    statuses: (string | undefined)[] = [],
    compactions: CompactOptions[] = [];
  const selects: (string | undefined)[] = [],
    inputs: (string | undefined)[] = [],
    confirms: boolean[] = [];
  const inputDefaults: string[] = [],
    selectOptions: string[][] = [],
    customRenders: string[][] = [];
  let tokens: number | null = 45000,
    idle = true,
    pending = false,
    clock = 100000;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: dir,
    sessionManager: sm,
    model: { id: "fixture", provider: "fixture", contextWindow: 272000 },
    signal: undefined,
    ui: {
      notify: (text: string) => notifications.push(text),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      select: async (_title: string, options: string[]) => {
        selectOptions.push(options);
        return selects.shift();
      },
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        let finish: (value: unknown) => void = () => {};
        const result = new Promise((resolve) => {
          finish = resolve;
        });
        const create = (done: (value: unknown) => void) =>
          factory(
            { requestRender() {} } as Parameters<typeof factory>[0],
            { fg: (_color: string, text: string) => text } as Parameters<typeof factory>[1],
            {
              matches: (data: string, binding: string) =>
                binding === "tui.select.confirm" ? data === "\r" : data === "\u001b",
            } as Parameters<typeof factory>[2],
            done,
          );
        const untouched = await create((value) => inputDefaults.push(String(value)));
        untouched.handleInput?.("\r");
        const component = await create(finish);
        const value = inputs.shift();
        if (value === undefined) component.handleInput?.("\u001b");
        else {
          component.handleInput?.("\u0001");
          component.handleInput?.("\u000b");
          for (const char of value) component.handleInput?.(char);
          if (typeof component.render === "function") customRenders.push(component.render(40));
          component.handleInput?.("\r");
        }
        return result;
      },
      confirm: async () => confirms.shift() ?? true,
    },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    getContextUsage: () => ({
      tokens,
      contextWindow: 272000,
      percent: tokens === null ? null : tokens / 2720,
    }),
    compact: (options: CompactOptions) => compactions.push(options),
    getSystemPrompt: () => "SYSTEM_SECRET_NOT_EXPORTED",
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, structuredClone(data)),
    registerCommand: (_name: string, options: { handler: typeof command }) => {
      command = options.handler;
    },
  } as unknown as ExtensionAPI;
  let calls = 0;
  const payloads: unknown[] = [];
  const signals: AbortSignal[] = [];
  const install = (version = "0.82.0", credential: string | undefined | false = "test-key") => {
    handlers.clear();
    installAdviser(api, {
      agentDir: dir,
      version,
      ...(credential === false ? {} : { key: () => credential }),
      now: () => clock,
      evaluate: async (state, key, signal) => {
        calls++;
        payloads.push(state);
        signals.push(signal);
        return evaluate(state, key, signal);
      },
    });
  };
  install();
  const fire = async (name: string, event: unknown = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    await flush();
    return results;
  };
  const next = (
    text = "New checkpoint saved",
    stop: "stop" | "error" | "aborted" | "length" | "toolUse" = "stop",
  ) => sm.appendMessage(assistant(text, stop));
  return {
    dir,
    store,
    sm,
    ctx,
    notifications,
    widgets,
    statuses,
    compactions,
    selects,
    inputs,
    confirms,
    inputDefaults,
    selectOptions,
    customRenders,
    payloads,
    signals,
    fire,
    next,
    install,
    command: async (args: string) => {
      if (!command) throw new Error("command missing");
      await command(args, ctx);
    },
    get calls() {
      return calls;
    },
    set tokens(value: number | null) {
      tokens = value;
    },
    set idle(value: boolean) {
      idle = value;
    },
    set pending(value: boolean) {
      pending = value;
    },
    set clock(value: number) {
      clock = value;
    },
    enable: (mode: "hint" | "auto" = "hint") =>
      store.update({ mode, autoAcknowledged: mode === "auto" }),
  };
}
