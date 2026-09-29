// A lab for driving the real CLI: a temporary GROK_HOME, a session directory shaped the way
// Grok writes one, and a loopback TypeSafe fixture. Nothing here stubs the package's own code,
// so a test that passes is the installed plugin working, not a mock of it.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const ENTRY = join(import.meta.dirname, "..", "bin", "adviser.ts");
export const PACKAGE_ROOT = join(import.meta.dirname, "..");

export interface Lab {
  home: string;
  cwd: string;
  sessionId: string;
  sessionDir: string;
  dataDir: string;
}

export function lab(t: TestContext, sessionId = "01a0b000-0000-7000-8000-00000000cafe"): Lab {
  const home = mkdtempSync(join(tmpdir(), "compact-adviser-grok-"));
  const cwd = join(home, "project");
  const sessionDir = join(home, "sessions", encodeURIComponent(cwd), sessionId);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, cwd, sessionId, sessionDir, dataDir: join(home, "compact-adviser") };
}

/** One `chat_history.jsonl` record, in the shapes Grok actually writes. */
export type Record_ =
  | { type: "system"; content: string }
  | { type: "user"; content: { type: string; text?: string }[] }
  | { type: "reasoning"; summary: unknown[] }
  | {
      type: "assistant";
      content: string;
      tool_calls?: { id: string; name: string; arguments: string }[];
    }
  | { type: "tool_result"; tool_call_id: string; content: string };

export function writeHistory(lab: Lab, records: readonly Record_[]): void {
  writeFileSync(
    join(lab.sessionDir, "chat_history.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

export function writeSignals(lab: Lab, tokens: number, window = 500000): void {
  writeFileSync(
    join(lab.sessionDir, "signals.json"),
    JSON.stringify({ contextTokensUsed: tokens, contextWindowTokens: window }),
  );
}

/** A transcript large enough to clear the conversation-token floor, ending on a finished unit. */
export function workedHistory(marker = "one"): Record_[] {
  const bulk = `Traced the parser through its callers and wrote the fix. ${marker} `.repeat(2200);
  return [
    { type: "system", content: "You are Grok." },
    {
      type: "user",
      content: [
        {
          type: "text",
          text: `<user_info>OS: macos</user_info>\n<user_query>Fix the parser bug ${marker}, run the tests, and commit.</user_query>`,
        },
      ],
    },
    {
      type: "assistant",
      content: `Working on it. ${bulk}`,
      tool_calls: [
        {
          id: `call-${marker}-1`,
          name: "search_replace",
          arguments: JSON.stringify({ file_path: `/repo/src/parser-${marker}.ts` }),
        },
      ],
    },
    { type: "tool_result", tool_call_id: `call-${marker}-1`, content: "edited 1 file" },
    {
      type: "assistant",
      content: `Done: the parser bug ${marker} is fixed, 12 of 12 tests pass, and it is committed. Nothing is pending.`,
    },
  ];
}

export interface Fixture {
  url: string;
  bodies: string[];
  close: () => void;
  /** Probabilities the next judgment answers with. */
  verdict: { finished: number; handsOn: number };
  /** When set, every request answers with this status instead of a judgment. */
  status?: number;
  /** When true, the body is larger than MAX_RESPONSE_BYTES. */
  oversize: boolean;
  /** When true, the request is accepted and never answered. */
  hang: boolean;
  /** Runs after a request body arrives and before it is answered. */
  onRequest?: () => void;
}

export function typesafeFixture(t: TestContext): Promise<Fixture> {
  const bodies: string[] = [];
  const state: Fixture = {
    url: "",
    bodies,
    close: () => undefined,
    verdict: { finished: 0.97, handsOn: 0.96 },
    oversize: false,
    hang: false,
  };
  const choice = (name: string, p: number, others: [string, string]) => ({
    type: "choice",
    choice: name,
    confidence: p,
    probabilities: { [name]: p, [others[0]]: (1 - p) / 2, [others[1]]: (1 - p) / 2 },
  });
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
      state.onRequest?.();
      if (state.hang) return;
      if (state.status !== undefined) {
        response.writeHead(state.status, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (state.oversize) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("x".repeat(32768 + 1));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            done: choice("finished", state.verdict.finished, ["not_finished", "unclear"]),
            shape: choice("hands_on", state.verdict.handsOn, ["coordinating", "unclear"]),
          },
          usage: { input_tokens: 2500, output_tokens: 40 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      state.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1/systemone`;
      state.close = () => server.close();
      t.after(() => server.close());
      resolve(state);
    });
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runShell(
  command: string,
  options: { lab?: Lab; stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const { lab, stdin = "", env = {} } = options;
  const child = spawn("sh", ["-c", command], {
    cwd: lab?.cwd ?? process.cwd(),
    env: {
      ...process.env,
      TYPESAFE_API_KEY: undefined,
      TYPESAFE_BASE: undefined,
      ...(lab ? { GROK_HOME: lab.home, GROK_SESSION_ID: lab.sessionId } : {}),
      NO_COLOR: "1",
      ...env,
    } as NodeJS.ProcessEnv,
  });
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function runLauncher(
  lab: Lab,
  args: readonly string[] = [],
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const { stdin = "", env = {} } = options;
  const child = spawn(join(lab.dataDir, "adviser.sh"), [...args], {
    cwd: lab.cwd,
    env: {
      ...process.env,
      TYPESAFE_API_KEY: undefined,
      GROK_HOME: lab.home,
      GROK_SESSION_ID: lab.sessionId,
      NO_COLOR: "1",
      ...env,
    } as NodeJS.ProcessEnv,
  });
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function runCli(
  args: readonly string[],
  options: { lab?: Lab; stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const { lab, stdin = "", env = {} } = options;
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: lab?.cwd ?? process.cwd(),
    env: {
      ...process.env,
      TYPESAFE_API_KEY: undefined,
      ...(lab ? { GROK_HOME: lab.home, GROK_SESSION_ID: lab.sessionId } : {}),
      NO_COLOR: "1",
      ...env,
    } as NodeJS.ProcessEnv,
  });
  child.stdin.end(stdin);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function stopPayload(lab: Lab, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hookEventName: "stop",
    hook_event_name: "Stop",
    sessionId: lab.sessionId,
    cwd: lab.cwd,
    workspaceRoot: lab.cwd,
    permissionMode: "default",
    promptId: "prompt-1",
    reason: "end_turn",
    stopHookActive: false,
    lastAssistantMessage: "Done.",
    backgroundTasks: [],
    sessionCrons: [],
    timestamp: new Date().toISOString(),
    ...patch,
  });
}

export function statusPayload(lab: Lab, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    session_id: lab.sessionId,
    cwd: lab.cwd,
    workspace: { current_dir: lab.cwd },
    model: { id: "grok-4.6", display_name: "Grok 4.6" },
    context_window: { context_tokens: 120000, context_window_size: 500000, used_percentage: 24 },
    ...patch,
  });
}
