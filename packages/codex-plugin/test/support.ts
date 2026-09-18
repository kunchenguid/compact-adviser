// Shared fixtures: a throwaway CODEX_HOME, a rollout transcript written record by record,
// and a TypeSafe stand-in that records what the hook actually sent.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../src/hook.ts";

export const TYPESAFE_KEY = "tsk-test-key-must-not-leave";

export interface Lab {
  home: string;
  cwd: string;
  transcript: string;
  cleanup: () => void;
}

export function makeLab(): Lab {
  const root = mkdtempSync(join(tmpdir(), "compact-adviser-codex-"));
  const home = join(root, "codex-home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    home,
    cwd,
    transcript: join(root, "rollout.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function writeRollout(path: string, records: readonly unknown[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

export function sessionMeta(originator = "codex-tui", source = "cli"): unknown {
  return { type: "session_meta", payload: { session_id: "s1", originator, source } };
}

export function tokenCount(total: number, window = 200000): unknown {
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: total }, model_context_window: window },
    },
  };
}

export function userMessage(text: string): unknown {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

export function assistantMessage(text: string): unknown {
  return {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

export function toolCall(name: string, input: string, callId = "call_1"): unknown {
  return {
    type: "response_item",
    payload: { type: "custom_tool_call", name, input, call_id: callId },
  };
}

export function toolOutput(text: string, callId = "call_1"): unknown {
  return {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [{ type: "input_text", text }],
    },
  };
}

/** A transcript long enough to clear the conversation-size gate, ending in a finished answer. */
export function settledRollout(options: { originator?: string; tokens?: number } = {}): unknown[] {
  const bulk = "Implementation notes for the parser module. ".repeat(2600);
  return [
    sessionMeta(options.originator ?? "codex-tui"),
    userMessage("Build the parser, then report."),
    toolCall("apply_patch", "*** Begin Patch\n*** Update File: src/parser.ts\n*** End Patch"),
    toolOutput(`Applied.\n${bulk}`),
    assistantMessage("Done: the parser is implemented, 12 of 12 tests pass, and it is committed."),
    tokenCount(options.tokens ?? 70000),
  ];
}

export function jevAnswer(finished = 0.99, handsOn = 0.99): unknown {
  const choice = (name: string, p: number, others: [string, string]) => ({
    type: "choice",
    choice: name,
    confidence: p,
    probabilities: { [name]: p, [others[0]]: (1 - p) / 2, [others[1]]: (1 - p) / 2 },
  });
  return {
    model: "jev-1.13.0",
    answers: {
      done: choice("finished", finished, ["not_finished", "unclear"]),
      shape: choice("hands_on", handsOn, ["coordinating", "unclear"]),
    },
    usage: { input_tokens: 2500, output_tokens: 0 },
  };
}

export interface FakeTypesafe {
  requests: { url: string; authorization: string | undefined; body: unknown }[];
  fetch: Environment["fetch"];
}

/** Answers like TypeSafe; `reply` decides each call's status and body. */
export function fakeTypesafe(
  reply: (call: number) => { status?: number; body?: unknown } = () => ({}),
): FakeTypesafe {
  const requests: FakeTypesafe["requests"] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: String(url),
      authorization: headers.Authorization,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const { status = 200, body = jevAnswer() } = reply(requests.length);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as Environment["fetch"];
  return { requests, fetch };
}

export function environment(lab: Lab, overrides: Partial<Environment> = {}): Environment {
  return {
    env: { CODEX_HOME: lab.home, TYPESAFE_API_KEY: TYPESAFE_KEY },
    now: () => 1_000_000,
    fetch: fakeTypesafe().fetch,
    ...overrides,
  };
}
