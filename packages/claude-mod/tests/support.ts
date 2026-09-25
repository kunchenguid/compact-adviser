// Shared fixtures for the compact-adviser suites under `claude plugin test`.
//
// Each test mocks the world beneath the plugin noun by noun: the environment, the
// plugin store and clock (the kit's own mocks), the `/config` rows the manifest declares,
// the session's usage and transcript, TypeSafe behind `$.http.fetch`, and a journal of
// every visible call the mod makes (status, toasts, logs, dialogs, suggestions).
import type { On, SessionMessage } from "claude-code";
import { type MockClock, mock } from "claude-code/testing";

export const PLUGIN = "compact-adviser";
export const KEY = "tsk-fixture-key-1234567890";
export const SESSION = "session-1";
export const START = 1_000_000;

export type Journal = {
  commands: string[];
  statuses: (string | undefined)[];
  toasts: string[];
  logs: string[];
  asks: string[];
  suggestions: string[];
  opened: { id: string; focus?: boolean }[];
  closed: string[];
  configSets: { key: string; value: unknown }[];
  requests: { url: string; headers: Record<string, string>; body: string }[];
  compactions: { instructions?: string }[];
  messageReads: number;
  usageReads: number;
  fsReads: string[];
  fsWrites: { path: string; text: string }[];
};

export type Verdict = { completed?: number; handsOn?: number };

export function jevAnswer(v: Verdict = {}) {
  const finished = v.completed ?? 0.99;
  const handsOn = v.handsOn ?? 0.99;
  const rest = (p: number) => Number(((1 - p) / 2).toFixed(6));
  const choice = (name: string, other: string, p: number) => ({
    type: "choice",
    choice: p >= 0.5 ? name : other,
    confidence: Math.abs(p - 0.5) * 2,
    probabilities: {
      [name]: p,
      [other]: rest(p),
      unclear: Number((1 - p - rest(p)).toFixed(6)),
    },
  });
  return {
    model: "jev-1.13.0",
    answers: {
      done: choice("finished", "not_finished", finished),
      shape: choice("hands_on", "coordinating", handsOn),
    },
    usage: { input_tokens: 2500, output_tokens: 0 },
  };
}

export type World = {
  clock: MockClock;
  store: Map<string, unknown>;
  journal: Journal;
  rows: Map<string, string | number | boolean>;
  sessionId: string;
  /** The next answers `$.ui.ask` gives, in order; an `undefined` entry dismisses the dialog. */
  answers: (string | undefined)[];
  usage: {
    tokens?: number;
    window: number;
    autoCompactThreshold?: number;
    autoCompactEnabled?: boolean;
  };
  messages: SessionMessage[];
  /** What TypeSafe answers; the default is a confident checkpoint. */
  respond: (body: string) => Promise<{ status: number; text: string } | { deny: string }>;
  /** What the engine's compaction answers for this mod's own request. */
  compact: () => Promise<
    { messages: SessionMessage[]; tokensBefore?: number; tokensAfter?: number } | { skip: string }
  >;
  denyConfig: (reason: string | undefined) => void;
  /** Request logs on disk by path; a path in `unreadableLogs` exists but its read rejects, as over 4 MiB. */
  logFiles: Map<string, string>;
  unreadableLogs: Set<string>;
};

export type WorldOptions = {
  functionHooks?: string | undefined;
  /** The `COMPACT_ADVISER_DISABLE` kill switch; omit to leave the variable unset. */
  disable?: string;
  key?: string | undefined;
  endpoint?: string;
  consent?: { autoAcknowledged: boolean } | "absent" | unknown;
  mode?: string;
  minimum?: number;
  logRequests?: boolean;
  savedKey?: string;
  store?: Record<string, unknown>;
  /** Text `$.fs.read(".env")` should return; omit to treat the file as missing. */
  dotenv?: string;
  /** `HOME` for the session; pass `undefined` to leave it unset. */
  home?: string | undefined;
};

/** A transcript whose own text is well over the 20k-token useful-history floor. */
export function longConversation(
  ask = "Please finish the parser and commit it.",
): SessionMessage[] {
  const filler = "Implementation notes for the parser module. ".repeat(2200);
  return [
    { role: "user", text: "Build a parser for the config format.", toolUses: [] },
    {
      role: "assistant",
      text: filler,
      toolUses: [
        {
          tool_use_id: "t1",
          tool: "Write",
          input: { file_path: "src/parser.ts", content: "export {}" },
          text: "File written",
        },
      ],
    },
    { role: "user", text: ask, toolUses: [] },
    {
      role: "assistant",
      text: "Done: the parser is implemented, 12 of 12 tests pass, and it is committed. Nothing is pending.",
      toolUses: [],
    },
  ];
}

export function world(on: On, options: WorldOptions = {}): World {
  const functionHooks = "functionHooks" in options ? options.functionHooks : "1";
  const key = "key" in options ? options.key : KEY;
  // Claude Code rejects host filesystem paths under macOS automounts such as /home.
  const home = "home" in options ? options.home : "/tmp/fixture-home";
  mock.env(on, {
    ...(home === undefined ? {} : { HOME: home }),
    ...(functionHooks === undefined ? {} : { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: functionHooks }),
    ...(key === undefined ? {} : { TYPESAFE_API_KEY: key }),
    ...(options.endpoint === undefined ? {} : { COMPACT_ADVISER_TEST_ENDPOINT: options.endpoint }),
    ...(options.disable === undefined ? {} : { COMPACT_ADVISER_DISABLE: options.disable }),
  });
  const consent = "consent" in options ? options.consent : "absent";
  // The plugin store, in memory and visible to the test.
  const store = new Map<string, unknown>(
    Object.entries({
      ...(consent === "absent" ? {} : { preferences: { version: 1, ...(consent as object) } }),
      ...(options.store ?? {}),
    }),
  );
  on("store.get", async (_$, e) => ({ value: structuredClone(store.get(e.key)) }));
  on("store.set", async (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)));
    return { value: undefined };
  });
  on("store.delete", async (_$, e) => {
    store.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", async () => ({ value: [...store.keys()] }));
  const clock = mock.clock(on, { now: START });
  const journal: Journal = {
    commands: [],
    statuses: [],
    toasts: [],
    logs: [],
    asks: [],
    suggestions: [],
    opened: [],
    closed: [],
    configSets: [],
    requests: [],
    compactions: [],
    messageReads: 0,
    usageReads: 0,
    fsReads: [],
    fsWrites: [],
  };
  const jsonlFiles = new Map<string, string>();
  const rows = new Map<string, string | number | boolean>([
    [`${PLUGIN}.mode`, options.mode ?? "hint"],
    [`${PLUGIN}.minContextTokens`, options.minimum ?? 40000],
    [`${PLUGIN}.logRequests`, options.logRequests ?? false],
    [`${PLUGIN}.typesafeApiKey`, options.savedKey ?? ""],
  ]);
  let configDenial: string | undefined;
  const w: World = {
    clock,
    store,
    journal,
    rows,
    sessionId: SESSION,
    answers: [],
    usage: { tokens: 60000, window: 200000, autoCompactThreshold: 167000 },
    messages: longConversation(),
    respond: async () => ({ status: 200, text: JSON.stringify(jevAnswer()) }),
    compact: async () => ({
      messages: [{ role: "user", text: "This session is being continued", toolUses: [] }],
      tokensBefore: 60000,
      tokensAfter: 3300,
    }),
    denyConfig: (reason) => {
      configDenial = reason;
    },
    logFiles: jsonlFiles,
    unreadableLogs: new Set(),
  };

  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("turn.start", async (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", async (_$, e) => ({ text: e.answer }));
  on("session.id", async () => ({ value: w.sessionId }));
  on("session.usage", async (_$, e) => {
    journal.usageReads += 1;
    const context: Record<string, unknown> = { window: w.usage.window };
    if (w.usage.tokens !== undefined) {
      context.tokens = w.usage.tokens;
      context.percent = Math.round((w.usage.tokens / w.usage.window) * 100);
    }
    if (e?.breakdown !== undefined) {
      context.breakdown = {
        categories: [],
        totalTokens: w.usage.tokens ?? 0,
        maxTokens: w.usage.window,
        rawMaxTokens: w.usage.window,
        autocompactSource: "model",
        percentage: 0,
        gridRows: [],
        model: "fixture",
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled:
          w.usage.autoCompactEnabled ?? w.usage.autoCompactThreshold !== undefined,
        ...(w.usage.autoCompactThreshold === undefined
          ? {}
          : { autoCompactThreshold: w.usage.autoCompactThreshold }),
        apiUsage: null,
      };
    }
    return { value: { context, rateLimits: [] } as never };
  });
  on("session.messages", async () => {
    journal.messageReads += 1;
    return { value: w.messages };
  });
  on("session.compact", async (_$, e) => {
    // The kit raises a plugin's `$.session.compact` with its arguments only; the engine
    // stamps `trigger: "plugin"` in a real session.
    if (e.trigger === "plugin" || e.trigger === undefined) {
      journal.compactions.push({ instructions: e.instructions });
      return (await w.compact()) as never;
    }
    return {
      messages: [{ role: "user", text: "This session is being continued", toolUses: [] }],
      tokensBefore: 50000,
      tokensAfter: 4000,
    };
  });
  on("config.list", async () => ({
    value: [...rows].map(([key, value]) => ({
      key,
      label: key,
      kind:
        typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "choice",
      value,
      provider: { plugin: PLUGIN, tier: "user" },
      isLocked: false,
    })) as never,
  }));
  on("config.set", async (_$, e) => {
    journal.configSets.push({ key: e.key, value: e.value });
    if (configDenial !== undefined) return { deny: configDenial };
    rows.set(e.key, e.value as string | number | boolean);
    return { value: e.value };
  });
  on("command.register", async (_$, e) => {
    journal.commands.push(e.name);
    return { value: { command: e.name } };
  });
  on("ui.status", async (_$, e) => {
    journal.statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.toast", async (_$, e) => {
    journal.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", async (_$, e) => {
    journal.logs.push(e.text);
    return { value: undefined };
  });
  // `$.ui.ask` is the engine's AskUserQuestion dialog, raised as a tool call.
  on("tool.call", async (_$, e) => {
    const call = e as unknown as { tool: string; questions: { question: string }[] };
    if (call.tool !== "AskUserQuestion") return { deny: `unexpected tool ${call.tool}` } as never;
    const question = call.questions[0]?.question ?? "";
    journal.asks.push(question);
    const answer = w.answers.shift();
    if (answer === undefined) return { deny: "dismissed" } as never;
    return { result: { questions: call.questions, answers: { [question]: answer } } } as never;
  });
  on("ui.open", async (_$, e) => {
    journal.opened.push({ id: e.id, focus: e.focus });
    return { value: { isPlaced: true } as never };
  });
  on("ui.close", async (_$, e) => {
    journal.closed.push(e.id);
    return { value: undefined };
  });
  on("ui.invalidate", async () => ({ value: undefined }));
  on("prompt.suggest", async (_$, e) => {
    journal.suggestions.push(e.text);
    return { isShown: true };
  });
  on("fs.read", async (_$, e, next) => {
    const envFile = e.path === ".env" || e.path.endsWith("/.env");
    if (envFile) journal.fsReads.push(e.path);
    if (envFile && options.dotenv !== undefined) return { value: options.dotenv };
    if (/compact-adviser-requests[^/]*\.jsonl$/.test(String(e.path))) {
      journal.fsReads.push(e.path);
      const existing = jsonlFiles.get(String(e.path));
      if (existing === undefined) throw new Error("ENOENT");
      if (w.unreadableLogs.has(String(e.path))) throw new Error("file is over 4 MiB");
      return { value: existing };
    }
    return next(e);
  });
  on("fs.exists", async (_$, e, next) => {
    if (/compact-adviser-requests[^/]*\.jsonl$/.test(String(e.path))) {
      return { value: jsonlFiles.has(String(e.path)) };
    }
    return next(e);
  });
  on("fs.write", async (_$, e) => {
    const write = e as { path: string; text: string };
    journal.fsWrites.push({ path: write.path, text: write.text });
    if (/compact-adviser-requests[^/]*\.jsonl$/.test(write.path))
      jsonlFiles.set(write.path, write.text);
    return { value: undefined };
  });
  on("http.fetch", async (_$, e) => {
    const init = (e.init ?? {}) as { headers?: Record<string, string>; body?: string };
    journal.requests.push({ url: e.url, headers: init.headers ?? {}, body: init.body ?? "" });
    const answer = await w.respond(init.body ?? "");
    if ("deny" in answer) return { deny: answer.deny };
    return {
      value: {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: {},
        text: answer.text,
      },
    };
  });
  return w;
}

export const interactiveStart = { cwd: "/work", surface: "terminal" as const, isInteractive: true };

export function answered(answer = "Done: committed, nothing pending.") {
  return {
    answer,
    durationMs: 1000,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer" as const,
  };
}

export function commandRun(args = "") {
  return {
    command: PLUGIN,
    args,
    origin: { kind: "composer" as const },
    presentation: { layout: "main" as const, isFullscreen: false, columns: 100 },
  };
}

export const pane = {
  surface: "terminal" as const,
  component: "Pane" as const,
  requestId: PLUGIN,
  viewport: { columns: 100, rows: 10 },
  props: { title: "Compact adviser (saved for all sessions)", isFocused: true },
} as never;

/** Every element in a drawing with its props, depth first. */
export function elements(tree: unknown): { type: string; props: Record<string, unknown> }[] {
  const found: { type: string; props: Record<string, unknown> }[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const element = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown };
    if (typeof element.type === "string")
      found.push({ type: element.type, props: element.props ?? {} });
    visit(element.children);
    if (element.props && "children" in element.props) visit(element.props.children);
  };
  visit(tree);
  return found;
}

export function text(tree: unknown): string {
  return JSON.stringify(tree);
}

/** The pane's rows as the person reads them: each Button's label, padding collapsed. */
export function rows(tree: unknown): string[] {
  return elements(tree)
    .filter((e) => e.type === "Button")
    .map((e) => String(e.props.label).replace(/\s+/g, " ").trim());
}

/** The key of the element drawn to take the ring first, if any. */
export function autoFocused(tree: unknown): string | undefined {
  return elements(tree).find((e) => e.props.autoFocus === true)?.props.key as string | undefined;
}
