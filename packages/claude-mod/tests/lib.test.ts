// The pure libraries under the same runtime as the hooks module: settings validation,
// cooldowns, the bounded judge input, and the Jev client with an injected transport.
import { describe, expect, test } from "claude-code/testing";
import {
  DEFAULT_MINIMUM,
  parseBudget,
  parseConsent,
  parseMinimum,
  parseSavedApiKey,
  readConfig,
} from "../lib/config.ts";
import { parseDotenvKey, resolveTypesafeApiKey } from "../lib/env.ts";
import {
  ENDPOINT,
  FLOOR_MAX,
  FLOOR_MIN,
  floorFor,
  JUDGE_DISABLED_NETWORK_MESSAGE,
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  judge,
  judgeErrorMessage,
  MAX_REQUEST_BYTES,
  parseJudgment,
  qualifies,
  requestBody,
  score,
  USAGE_LOOSE_AT,
  USAGE_STRICT_UNTIL,
} from "../lib/judge.ts";
import {
  errorLogLine,
  loggedJudgeErrorKind,
  requestLogId,
  requestLogLine,
  requestLogName,
  requestLogPath,
  responseLogLine,
} from "../lib/log.ts";
import { RECENT_TAIL_MESSAGES, SUMMARY_PREFIX, snapshot } from "../lib/snapshot.ts";
import {
  backoff,
  completeExchange,
  cooldownReason,
  initialState,
  restoreState,
  SESSION_RETENTION_MS,
  staleSessionKeys,
} from "../lib/state.ts";
import { jevAnswer, longConversation } from "./support.ts";

const rows = (mode: unknown, minimum: unknown) => [
  { key: "compact-adviser.mode", value: mode },
  { key: "compact-adviser.minContextTokens", value: minimum },
];

describe("settings", () => {
  test("a budget is a whole number of tokens, and off or default clears it", () => {
    expect(parseBudget(" 450000 ")).toBe(450000);
    expect(parseBudget("off")).toBe(0);
    expect(parseBudget("default")).toBe(0);
    for (const bad of ["", "-1", "1.5", "450k", "4e5", "9007199254740992"]) {
      expect(() => parseBudget(bad)).toThrow("whole number");
    }
  });

  test("the minimum is a positive safe whole decimal number of tokens", () => {
    expect(parseMinimum(" 40000 ")).toBe(40000);
    expect(parseMinimum("60000")).toBe(60000);
    for (const value of [
      "",
      "0",
      "-1",
      "1.5",
      "40k",
      "4e4",
      "NaN",
      "Infinity",
      "9007199254740992",
      "0x10",
    ]) {
      expect(() => parseMinimum(value)).toThrow(
        "Enter a positive whole number of tokens, for example 40000.",
      );
    }
    expect(DEFAULT_MINIMUM).toBe(40000);
  });

  test("saved API key parsing trims, rejects empty, overlong, and control characters", () => {
    expect(parseSavedApiKey("  tsk-ok  ")).toBe("tsk-ok");
    expect(() => parseSavedApiKey("   ")).toThrow("Enter a TypeSafe API key");
    expect(() => parseSavedApiKey("x".repeat(1025))).toThrow("too long");
    expect(() => parseSavedApiKey("tsk\nok")).toThrow("control characters");
  });

  test("configuration combines the host rows with stored acknowledgement and ignores legacy sharingConsent", () => {
    expect(readConfig(rows("hint", 40000), undefined)).toEqual({
      mode: "hint",
      minContextTokens: 40000,
      contextBudgetTokens: 0,
      autoAcknowledged: false,
      logRequests: false,
    });
    expect(
      readConfig(rows("auto", 60000), {
        version: 1,
        sharingConsent: false,
        autoAcknowledged: true,
      }),
    ).toEqual({
      mode: "auto",
      minContextTokens: 60000,
      contextBudgetTokens: 0,
      autoAcknowledged: true,
      logRequests: false,
    });
  });

  test("unreadable rows or consent records are reported, never replaced by permissive values", () => {
    expect(() => readConfig(rows("turbo", 40000), undefined)).toThrow("mode");
    expect(() => readConfig(rows("hint", 0), undefined)).toThrow("minimum");
    expect(() => readConfig(rows("hint", 1.5), undefined)).toThrow("minimum");
    expect(() => readConfig([], undefined)).toThrow("mode");
    const budget = (value: unknown) => [
      ...rows("hint", 40000),
      { key: "compact-adviser.contextBudgetTokens", value },
    ];
    expect(readConfig(budget(450000), undefined).contextBudgetTokens).toBe(450000);
    for (const bad of [-1, 1.5, "450000"]) {
      expect(() => readConfig(budget(bad), undefined)).toThrow("context budget");
    }
    expect(readConfig([], undefined, { mode: "off", minContextTokens: 50000 }).mode).toBe("off");
    expect(
      readConfig(rows("auto", 70000), undefined, { mode: "off", minContextTokens: 50000 })
        .minContextTokens,
    ).toBe(70000);
    expect(() =>
      parseConsent({ version: 2, sharingConsent: true, autoAcknowledged: true }),
    ).toThrow("consent");
    expect(() => parseConsent({ version: 1, autoAcknowledged: "yes" })).toThrow("consent");
  });
});

describe("cwd .env key", () => {
  test("last TYPESAFE_API_KEY assignment wins; comments and blanks are ignored", () => {
    expect(
      parseDotenvKey(
        "# TYPESAFE_API_KEY=commented\n\nOTHER=nope\nTYPESAFE_API_KEY=first\nTYPESAFE_API_KEY=second\n",
        "TYPESAFE_API_KEY",
      ),
    ).toBe("second");
    expect(parseDotenvKey("", "TYPESAFE_API_KEY")).toBeUndefined();
  });

  test("export and declare -x prefixes and one matching quote layer are stripped", () => {
    expect(parseDotenvKey("export TYPESAFE_API_KEY=from-export\n", "TYPESAFE_API_KEY")).toBe(
      "from-export",
    );
    expect(parseDotenvKey('declare -x TYPESAFE_API_KEY="from-declare"\n', "TYPESAFE_API_KEY")).toBe(
      "from-declare",
    );
    expect(parseDotenvKey("TYPESAFE_API_KEY='from-single'\n", "TYPESAFE_API_KEY")).toBe(
      "from-single",
    );
    expect(parseDotenvKey('TYPESAFE_API_KEY="from-double"\n', "TYPESAFE_API_KEY")).toBe(
      "from-double",
    );
    expect(
      parseDotenvKey('export TYPESAFE_API_KEY="from-export-quoted"\n', "TYPESAFE_API_KEY"),
    ).toBe("from-export-quoted");
  });

  test("env wins over saved over .env; empty env falls through", () => {
    expect(resolveTypesafeApiKey("from-env", "from-saved", "from-dotenv")).toEqual({
      value: "from-env",
      source: "env",
    });
    expect(resolveTypesafeApiKey("   ", "from-saved", "from-dotenv")).toEqual({
      value: "from-saved",
      source: "saved",
    });
    expect(resolveTypesafeApiKey(undefined, "from-saved", "from-dotenv")).toEqual({
      value: "from-saved",
      source: "saved",
    });
    expect(resolveTypesafeApiKey(undefined, "   ", "from-dotenv")).toEqual({
      value: "from-dotenv",
      source: ".env",
    });
    expect(resolveTypesafeApiKey(undefined, undefined, undefined)).toEqual({
      value: undefined,
      source: "missing",
    });
  });
});

describe("session cooldowns", () => {
  test("a fresh session has no cooldown; a malformed record restarts snoozed and compacted", () => {
    expect(cooldownReason(initialState(false, 0), 50000, 0)).toBeUndefined();
    const broken = restoreState({ version: 1, completed: -1 }, 5);
    expect(broken.snoozeUntil).toBe(3);
    expect(broken.compacted).toBe(true);
    expect(cooldownReason(broken, 90000, 5)).toBe("Snoozed");
  });

  test("after compaction: fresh usage, then 20k more tokens and 3 completed exchanges", () => {
    let s = initialState(true, 0);
    s = completeExchange(s, undefined, 1);
    expect(s.baseline).toBeNull();
    expect(cooldownReason(s, 90000, 1)).toBe(
      "Waiting for 20k new tokens and 3 completed exchanges after compaction",
    );
    s = completeExchange(s, 5000, 2);
    expect(s.baseline).toBe(5000);
    s = completeExchange(s, 30000, 3);
    expect(s.baseline).toBe(5000);
    expect(cooldownReason(s, 24999, 3)).toBeDefined();
    expect(cooldownReason(s, 25000, 3)).toBeUndefined();
  });

  test("a recent hint does not cooldown; snooze and capped exponential backoff still do", () => {
    const hinted = { ...initialState(false, 0), completed: 4, lastHintAt: 2 };
    expect(cooldownReason(hinted, 60000, 0)).toBeUndefined();
    expect(cooldownReason({ ...hinted, completed: 5 }, 60000, 0)).toBeUndefined();
    const failed = backoff(initialState(false, 0), 1000);
    expect(failed.retryAfter).toBe(11000);
    expect(cooldownReason(failed, 60000, 10999)).toBe("TypeSafe backoff");
    let many = initialState(false, 0);
    for (let i = 0; i < 10; i++) many = backoff(many, 0);
    expect(many.failures).toBe(6);
    expect(many.retryAfter).toBe(300000);
  });

  test("only session records older than the retention window are pruned", () => {
    const now = SESSION_RETENTION_MS * 2;
    expect(
      staleSessionKeys(
        [
          { key: "session:old", value: { updatedAt: 1 } },
          { key: "session:new", value: { updatedAt: now - 10 } },
          { key: "session:broken", value: null },
          { key: "preferences", value: { updatedAt: 1 } },
        ],
        now,
      ),
    ).toEqual(["session:old", "session:broken"]);
  });
});

describe("judge input", () => {
  test("bounded state excludes secrets and sensitive files and keeps coverage markers", () => {
    const view = snapshot([
      {
        role: "user",
        text: `${SUMMARY_PREFIX}. Summary: API_KEY=summarysecret1 earlier work`,
        toolUses: [],
      },
      { role: "user", text: "API_KEY=secretvalue123 keep the requirement", toolUses: [] },
      {
        role: "assistant",
        text: "Saved. Bearer fixtureSecretToken and sk-abcdefghijklmnop",
        toolUses: [
          {
            tool_use_id: "a",
            tool: "Read",
            input: { file_path: "/repo/.env" },
            text: "DB_PASSWORD=hunter2",
          },
          { tool_use_id: "b", tool: "Write", input: { file_path: "docs/out.md" }, text: "ok" },
          { tool_use_id: "c", tool: "Write", input: { file_path: "id_rsa" }, text: "ok" },
        ],
      },
    ]);
    const body = requestBody(view.state);
    for (const secret of [
      "secretvalue123",
      "fixtureSecretToken",
      "sk-abcdefghijklmnop",
      "hunter2",
      "summarysecret1",
    ]) {
      expect(body.includes(secret)).toBe(false);
    }
    expect(body).toContain("keep the requirement");
    expect(body).toContain("[Sensitive file content excluded]");
    expect(view.state.previousSummary).toContain("earlier work");
    expect(view.state.savedArtifacts).toEqual(["docs/out.md"]);
    expect(view.state.userConstraints).toHaveLength(1);
    expect(view.state.coverage.redacted).toBe(true);
    expect(view.autoCoverage).toBe(false);
  });

  test("a settings.json read keeps non-secret options and drops the saved TypeSafe key", () => {
    const secret = "tsk-saved-key-must-not-leave";
    const view = snapshot(
      [
        ...longConversation(),
        {
          role: "assistant",
          text: "Saved notes.",
          toolUses: [
            {
              tool_use_id: "write-notes",
              tool: "Write",
              input: { file_path: `/tmp/notes-${secret}.md` },
              text: "ok",
            },
          ],
        },
        {
          role: "assistant",
          text: "Read the plugin settings.",
          toolUses: [
            {
              tool_use_id: "settings",
              tool: "Read",
              input: { file_path: "/home/fixture/.claude/settings.json" },
              text: JSON.stringify({
                pluginConfigs: {
                  "compact-adviser@0.1.0": {
                    options: {
                      mode: "hint",
                      minContextTokens: 40000,
                      logRequests: true,
                      typesafeApiKey: secret,
                    },
                  },
                },
              }),
            },
          ],
        },
      ],
      [secret],
    );
    const body = requestBody(view.state);
    expect(body.includes(secret)).toBe(false);
    expect(body).toContain("hint");
    expect(body).toContain("40000");
    expect(body).toContain("[REDACTED]");
    expect(view.state.coverage.redacted).toBe(true);
    expect(view.state.savedArtifacts).toContain("/tmp/notes-[REDACTED].md");
  });

  test("shell redirection, tee, and sed -i feed the saved-artifact list", () => {
    const bash = (id: string, command: string) => ({
      tool_use_id: id,
      tool: "Bash",
      input: { command },
      text: "ok",
    });
    const view = snapshot([
      { role: "user", text: "Save the findings, then verify.", toolUses: [] },
      {
        role: "assistant",
        text: "Saved through the shell.",
        toolUses: [
          bash("s1", "echo hi > docs/out.md"),
          bash("s2", "cat in.txt | tee copy.txt"),
          bash("s3", "sed -i -e 's/a/b/' notes.md"),
          bash("s4", "echo hi >| clobber.txt"),
          bash("s5", "sed --in-place 's/a/b/' in-place-long.txt"),
          bash("s6", "sed --in-place=.bak 's/a/b/' in-place-suffix.txt"),
          bash("s7", "sed -i 's/a/b/' in-place-ambiguous.txt"),
        ],
      },
    ]);
    expect(view.state.savedArtifacts).toEqual([
      "docs/out.md",
      "copy.txt",
      "notes.md",
      "clobber.txt",
      "in-place-long.txt",
      "in-place-suffix.txt",
    ]);
  });

  test("tee and in-place sed after a bash reserved word still feed the saved artifacts", () => {
    const bash = (id: string, command: string) => ({
      tool_use_id: id,
      tool: "Bash",
      input: { command },
      text: "ok",
    });
    const view = snapshot([
      { role: "user", text: "Save the findings, then verify.", toolUses: [] },
      {
        role: "assistant",
        text: "Captured inside the compound commands.",
        toolUses: [
          // Near misses: after a reserved word the next word is not the tee/sed command.
          bash("n1", "if [ -f a ]; then cat out.txt; fi"),
          bash("n2", "for tee in a b; do :; done"),
          bash("n3", "if grep -q sed notes.md; then :; fi"),
          bash("r1", "if [ -f a ]; then tee out.txt; fi"),
          bash("r2", "if [ -f a ]; then sed -i -e s/a/b/ notes.md; fi"),
          bash("r3", "for i in 1; do tee t.txt; done"),
          bash("r4", "{ tee brace.txt; }"),
        ],
      },
    ]);
    expect(view.state.savedArtifacts).toEqual(["out.txt", "notes.md", "t.txt", "brace.txt"]);
  });

  test("a Bash command that writes nothing adds no artifact, and sensitive or failed writes stay out", () => {
    const bash = (
      id: string,
      command: string,
      extra: Partial<{ isError: true; text: string }> = {},
    ) => ({ tool_use_id: id, tool: "Bash", input: { command }, text: "ok", ...extra });
    const view = snapshot([
      { role: "user", text: "Run the checks.", toolUses: [] },
      {
        role: "assistant",
        text: "Done.",
        toolUses: [
          bash("n1", "npm test"),
          bash("n2", "cat <<EOF\nfake > nope.txt\nEOF"),
          bash("n3", 'echo hi >> "$TARGET"'),
          bash("n4", "echo hi > .env"),
          bash("n5", "echo hi > failed.txt", { isError: true }),
        ],
      },
    ]);
    expect(view.state.savedArtifacts).toEqual([]);
  });

  test("the saved-artifact bound still holds when the shell writes many files", () => {
    const uses = Array.from({ length: 10 }, (_, i) => ({
      tool_use_id: `w${String(i)}`,
      tool: "Bash",
      input: { command: `echo run > run-${String(i)}.txt` },
      text: "ok",
    }));
    const view = snapshot([{ role: "assistant", text: "", toolUses: uses }]);
    expect(view.state.savedArtifacts).toHaveLength(8);
    expect(view.state.savedArtifacts[0]).toBe("run-2.txt");
    expect(view.state.savedArtifacts.at(-1)).toBe("run-9.txt");
  });

  test("recent tail keeps the last 64 assistant messages when they fit the byte budget", () => {
    const older = Array.from({ length: 20 }, (_, i) => ({
      role: "assistant" as const,
      text: `old-${i}`,
      toolUses: [],
    }));
    const recent = Array.from({ length: RECENT_TAIL_MESSAGES }, (_, i) => ({
      role: "assistant" as const,
      text: `keep-${i}`,
      toolUses: [],
    }));
    const view = snapshot([...older, ...recent]);
    expect(view.state.coverage.olderMessagesOmitted).toBe(older.length);
    expect(view.state.recent.map((m) => m.text)).toEqual(recent.map((m) => m.text));
    expect(view.state.recent.length).toBeGreaterThan(6);
    expect(view.state.coverage.recentTextTruncated).toBe(false);
    expect(view.autoCoverage).toBe(true);
  });

  test("tool results in the 64-message window keep a head and tail and leave sibling budget", () => {
    const huge = `TOOLHEAD${"m".repeat(4000)}TOOLMID${"n".repeat(4000)}TOOLTAIL`;
    const view = snapshot([
      { role: "assistant", text: "SIBLING-OLD", toolUses: [] },
      {
        role: "assistant",
        text: "called bash",
        toolUses: [{ tool_use_id: "t1", tool: "Bash", input: { command: "cat log" }, text: huge }],
      },
      { role: "assistant", text: "SIBLING-NEW", toolUses: [] },
    ]);
    expect(view.state.recent.map((m) => m.text)).toEqual([
      "SIBLING-OLD",
      "called bash",
      "SIBLING-NEW",
    ]);
    const excerpt = view.state.recent[1]?.tools?.[0]?.excerpt ?? "";
    expect(excerpt.includes("TOOLHEAD")).toBe(true);
    expect(excerpt.includes("TOOLTAIL")).toBe(true);
    expect(/\[truncated \d+ bytes\]/.test(excerpt)).toBe(true);
    expect(excerpt.includes("TOOLMID")).toBe(false);
    expect(new TextEncoder().encode(excerpt).byteLength).toBeLessThanOrEqual(512);
    expect(new TextEncoder().encode(requestBody(view.state)).byteLength).toBeLessThanOrEqual(
      MAX_REQUEST_BYTES,
    );
  });

  test("a 64-message window still clips to the tail budget and the request cap", () => {
    const view = snapshot(
      Array.from({ length: RECENT_TAIL_MESSAGES }, (_, i) => ({
        role: "assistant" as const,
        text: `clip-${i}-${"x".repeat(2000)}`,
        toolUses: [],
      })),
    );
    expect(view.state.coverage.olderMessagesOmitted).toBe(0);
    expect(view.state.coverage.recentTextTruncated).toBe(true);
    expect(new TextEncoder().encode(requestBody(view.state)).byteLength).toBeLessThanOrEqual(
      MAX_REQUEST_BYTES,
    );
  });

  test("a long transcript stays within the request cap and discloses truncation", () => {
    const view = snapshot(longConversation());
    expect(new TextEncoder().encode(requestBody(view.state)).byteLength).toBeLessThanOrEqual(
      MAX_REQUEST_BYTES,
    );
    expect(view.conversationTokens).toBeGreaterThan(20000);
    expect(view.state.coverage.recentTextTruncated).toBe(true);
    expect(view.autoCoverage).toBe(false);
    const short = snapshot(longConversation().slice(2));
    expect(short.autoCoverage).toBe(true);
    expect(short.conversationTokens).toBeLessThan(20000);
  });

  test("the checkpoint fingerprint text follows the latest ask and reply", () => {
    const a = snapshot(longConversation("first ask")).checkpointText;
    const b = snapshot(longConversation("second ask")).checkpointText;
    expect(a === b).toBe(false);
    expect(snapshot(longConversation("first ask")).checkpointText).toBe(a);
  });
});

describe("jev client", () => {
  const ok = (value: unknown) => async () => ({
    status: 200,
    ok: true,
    text: JSON.stringify(value),
  });
  const never = () => new Promise<never>(() => undefined);

  test("posts jev-latest with the bearer key in a header and the phase question", async () => {
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const result = await judge({ recent: [] }, "tsk-secret", {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return { status: 200, ok: true, text: JSON.stringify(jevAnswer()) };
      },
      sleep: never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.init.headers.Authorization).toBe("Bearer tsk-secret");
    const body = JSON.parse(calls[0]?.init.body ?? "{}");
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["done", "shape"]);
    expect(calls[0]?.init.body.includes("tsk-secret")).toBe(false);
    expect(result.done.choice).toBe("finished");
    expect(result.shape.choice).toBe("hands_on");
  });

  test("errors map to kinds and never to a judgment", async () => {
    const kind = async (transport: Parameters<typeof judge>[2]) => {
      try {
        await judge({}, "k", transport);
        return "judged";
      } catch (error) {
        return error instanceof JudgeError ? error.kind : "other";
      }
    };
    const status = (code: number) => async () => ({ status: code, ok: false, text: "" });
    expect(await kind({ fetch: status(401), sleep: never })).toBe("authentication");
    expect(await kind({ fetch: status(403), sleep: never })).toBe("authentication");
    expect(await kind({ fetch: status(429), sleep: never })).toBe("rate-limit");
    expect(await kind({ fetch: status(529), sleep: never })).toBe("server");
    expect(await kind({ fetch: async () => Promise.reject(new Error("down")), sleep: never })).toBe(
      "network",
    );
    expect(await kind({ fetch: never, sleep: async () => undefined })).toBe("timeout");
    expect(
      await kind({
        fetch: async () => ({ status: 200, ok: true, text: "not json" }),
        sleep: never,
      }),
    ).toBe("response");
    expect(
      await kind({
        fetch: async () => ({ status: 200, ok: true, text: "x".repeat(40000) }),
        sleep: never,
      }),
    ).toBe("response");
    expect(await kind({ fetch: ok(jevAnswer()), sleep: never })).toBe("judged");
    expect(() => requestBody({ huge: "x".repeat(MAX_REQUEST_BYTES) })).toThrow(JudgeError);
  });

  test("strict validation rejects unoffered choices, bad sums, and a non-maximal choice", () => {
    const base = jevAnswer();
    const mutate = (fn: (a: ReturnType<typeof jevAnswer>) => void) => {
      const copy = JSON.parse(JSON.stringify(base));
      fn(copy);
      return () => parseJudgment(copy);
    };
    expect(() => parseJudgment(base)).not.toThrow();
    expect(
      mutate((a) => {
        (a.answers.done as { choice: string }).choice = "completed";
      }),
    ).toThrow(JudgeError);
    expect(
      mutate((a) => {
        a.answers.done.probabilities.unclear = 0.5;
      }),
    ).toThrow(JudgeError);
    expect(
      mutate((a) => {
        (a.answers.done.probabilities as Record<string, number>).extra = 0;
      }),
    ).toThrow(JudgeError);
    expect(
      mutate((a) => {
        a.answers.done.choice = "unclear";
      }),
    ).toThrow(JudgeError);
    expect(
      mutate((a) => {
        a.answers.shape.confidence = 1.2;
      }),
    ).toThrow(JudgeError);
    expect(
      mutate((a) => {
        (a.usage as { input_tokens: unknown }).input_tokens = -1;
      }),
    ).toThrow(JudgeError);
    expect(
      mutate((a) => {
        (a as { model: unknown }).model = 7;
      }),
    ).toThrow(JudgeError);
  });

  test("judgment-failure notices explain the skip and which kinds can be temporary", () => {
    for (const kind of ["timeout", "network", "rate-limit", "server", "response"] as const) {
      const message = judgeErrorMessage(kind);
      expect(message).toContain("asked TypeSafe (Jev)");
      expect(message).toContain("left unchanged on purpose");
      expect(message).toContain("compact or hint cannot come from a bad answer");
      expect(message).toContain("can be temporary");
      expect(message).toContain("try again later");
      expect(message).toContain("unless it keeps repeating");
    }
    for (const kind of ["authentication", "input"] as const) {
      const message = judgeErrorMessage(kind);
      expect(message).toContain("asked TypeSafe (Jev)");
      expect(message).toContain("left unchanged on purpose");
      expect(message.includes("can be temporary")).toBe(false);
      expect(message.includes("try again later")).toBe(false);
      expect(message).toContain("not a temporary glitch");
    }
    expect(judgeErrorMessage("authentication")).toContain("TypeSafe key configuration");
    expect(judgeErrorMessage("input")).toContain("size limit");
    expect(JUDGE_UNAVAILABLE_MESSAGE).toContain("can be temporary");
    expect(JUDGE_DISABLED_NETWORK_MESSAGE).toContain("nonessential network traffic disabled");
    expect(JUDGE_DISABLED_NETWORK_MESSAGE.includes("can be temporary")).toBe(false);
    expect(JUDGE_DISABLED_NETWORK_MESSAGE).toContain("configuration setting");
  });

  test("a missing second answer is rejected", () => {
    const partial = jevAnswer() as { answers: Partial<ReturnType<typeof jevAnswer>["answers"]> };
    delete partial.answers.shape;
    expect(() => parseJudgment(partial)).toThrow(JudgeError);
  });

  test("the composed score and the usage-dependent floor decide hint and auto the same way", () => {
    const j = (v: Parameters<typeof jevAnswer>[0]) => parseJudgment(jevAnswer(v));
    expect(FLOOR_MAX).toBe(0.9);
    expect(FLOOR_MIN).toBe(0.5);
    expect(USAGE_STRICT_UNTIL).toBe(0.1);
    expect(USAGE_LOOSE_AT).toBe(0.9);
    expect(Math.abs(score(j({ completed: 1, handsOn: 1 })) - 1) < 1e-9).toBe(true);
    expect(Math.abs(score(j({ completed: 1, handsOn: 0 })) - 0.5) < 1e-9).toBe(true);
    expect(Math.abs(score(j({ completed: 0, handsOn: 1 })) - 0) < 1e-9).toBe(true);
    expect(floorFor(0.1)).toBe(0.9);
    expect(floorFor(0.3)).toBe(0.8);
    expect(floorFor(0.5)).toBe(0.7);
    expect(floorFor(0.9)).toBe(0.5);
    expect(floorFor(0.95)).toBe(0.5);
    expect(floorFor(Number.NaN)).toBe(0.9);
    expect(qualifies(j({ completed: 0.95, handsOn: 0.95 }), 0.2)).toBe(true);
    expect(qualifies(j({ completed: 0.89, handsOn: 0.99 }), 0)).toBe(false);
    expect(qualifies(j({ completed: 0.99, handsOn: 0 }), 0.3)).toBe(false);
    expect(qualifies(j({ completed: 1, handsOn: 0 }), 0.89)).toBe(false);
    expect(qualifies(j({ completed: 1, handsOn: 0 }), 0.9)).toBe(true);
    expect(qualifies(j({ completed: 0.2, handsOn: 1 }), 1)).toBe(false);
  });

  test("TypeSafe log lines record the gate decision without secrets", () => {
    const secret = "tsk-fixture-must-not-leave";
    const body = requestBody({ note: "ok" });
    const judgment = parseJudgment(jevAnswer({ completed: 0.93, handsOn: 0.97 }));
    const at = "2026-09-18T00:00:00.000Z";
    const usage = 0.2;
    const request = JSON.parse(requestLogLine(body, at));
    const response = JSON.parse(responseLogLine(body, judgment, usage, at));
    const failure = JSON.parse(errorLogLine("timeout", body, at));
    expect(request.kind).toBe("request");
    expect(request.id).toBe(requestLogId(body));
    expect(request.body.model).toBe("jev-latest");
    expect(response.kind).toBe("response");
    expect(response.id).toBe(request.id);
    expect(response.answers.done.choice).toBe("finished");
    expect(response.answers.done.probabilities).toEqual(judgment.done.probabilities);
    expect(response.answers.shape.choice).toBe("hands_on");
    expect(response.answers.shape.probabilities).toEqual(judgment.shape.probabilities);
    expect(response.score).toBe(score(judgment));
    expect(response.usage).toBe(usage);
    expect(response.floor).toBe(floorFor(usage));
    expect(response.qualifies).toBe(qualifies(judgment, usage));
    expect(failure.kind).toBe("error");
    expect(failure.id).toBe(request.id);
    expect(failure.error).toEqual({ kind: "timeout" });
    const unknownUsage = JSON.parse(responseLogLine(body, judgment, Number.NaN, at));
    expect(unknownUsage.usage).toBe(null);
    expect(unknownUsage.floor).toBe(FLOOR_MAX);
    expect(unknownUsage.qualifies).toBe(qualifies(judgment, Number.NaN));
    const auth = new JudgeError("authentication");
    expect(loggedJudgeErrorKind(auth)).toBe("authentication");
    expect(loggedJudgeErrorKind(new Error(`boom ${secret}`))).toBe("unavailable");
    for (const line of [
      requestLogLine(body, at),
      responseLogLine(body, judgment, usage, at),
      errorLogLine(loggedJudgeErrorKind(auth), body, at),
      errorLogLine(loggedJudgeErrorKind(new Error(`boom ${secret}`)), body, at),
    ]) {
      expect(line.includes(secret)).toBe(false);
      expect(line.includes("Authorization")).toBe(false);
      expect(line.includes("Bearer")).toBe(false);
      expect(line.includes(auth.message)).toBe(false);
    }
  });

  test("TypeSafe request logs are per session and stay under ~/.claude", () => {
    expect(requestLogName("session-1")).toBe("compact-adviser-requests-session-1.jsonl");
    expect(requestLogPath("/home/fixture", "session-1")).toBe(
      "/home/fixture/.claude/compact-adviser-requests-session-1.jsonl",
    );
    expect(requestLogPath("/home/fixture/", "../secret")).toBe(
      "/home/fixture/.claude/compact-adviser-requests-_secret.jsonl",
    );
    expect(requestLogName("")).toBe("compact-adviser-requests-session.jsonl");
  });
});
