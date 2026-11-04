import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigStore } from "../src/config.ts";
import { HINT, handle } from "../src/hook.ts";
import { QUESTIONS } from "../src/judge.ts";
import { requestLogPath } from "../src/log.ts";
import { adviserRoot } from "../src/paths.ts";
import { environment, fakeTypesafe, makeLab, settledRollout, writeRollout } from "./support.ts";

const response = {
  model: "gpt-6-luna",
  answers: Object.entries(QUESTIONS).map(([name, q]) => ({
    name,
    type: "choice",
    choice: Object.keys(q.criteria)[0],
    confidence: 1,
    probabilities: Object.keys(q.criteria).map((value, i) => ({
      value,
      probability: i === 0 ? 1 : 0,
    })),
  })),
  usage: { input_tokens: 42, output_tokens: 0 },
};

test("Codex Stop routes Decisions, logs the sent body and never falls back to TypeSafe keys", async (t) => {
  const lab = makeLab();
  t.after(lab.cleanup);
  writeRollout(lab.transcript, settledRollout());
  const fixture = fakeTypesafe(() => ({ body: response }));
  const base = environment(lab);
  const env = {
    ...base.env,
    COMPACT_ADVISER_PROVIDER: "openai-decisions",
    OPENAI_API_KEY: "openai-fixture",
    TYPESAFE_BASE: "invalid",
  };
  const root = adviserRoot(env);
  new ConfigStore(root).update({ logRequests: true, typesafeApiKey: "inactive-saved" });
  const stop = {
    hook_event_name: "Stop",
    session_id: "decisions",
    transcript_path: lab.transcript,
    cwd: lab.cwd,
    last_assistant_message: "Done.",
  };
  assert.deepEqual(await handle(stop, { ...base, env, fetch: fixture.fetch }), {
    systemMessage: HINT,
  });
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]?.url, "https://api.openai.com/v1/decisions");
  assert.equal(fixture.requests[0]?.authorization, "Bearer openai-fixture");
  const lines = readFileSync(requestLogPath(root, "decisions"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines[0].body, fixture.requests[0]?.body);
  assert.equal(lines[0].provider, "openai-decisions");
  assert.equal(lines[1].provider, "openai-decisions");
  writeFileSync(join(lab.cwd, ".env"), "OPENAI_API_KEY=ignored\nTYPESAFE_API_KEY=ignored\n");
  for (const provider of ["openai-decisions", "invalid"]) {
    assert.deepEqual(
      await handle(
        { ...stop, session_id: provider },
        {
          ...base,
          env: { ...env, COMPACT_ADVISER_PROVIDER: provider, OPENAI_API_KEY: undefined },
          fetch: fixture.fetch,
        },
      ),
      {},
    );
  }
  assert.equal(fixture.requests.length, 1);
});

test("Codex stops reading oversized Decisions success and error streams", async (t) => {
  const lab = makeLab();
  t.after(lab.cleanup);
  writeRollout(lab.transcript, settledRollout());
  for (const status of [200, 429]) {
    let cancelled = false;
    let pulls = 0;
    const base = environment(lab);
    const result = await handle(
      {
        hook_event_name: "Stop",
        session_id: `oversize-${status}`,
        transcript_path: lab.transcript,
        cwd: lab.cwd,
        last_assistant_message: "Done.",
      },
      {
        ...base,
        env: {
          ...base.env,
          COMPACT_ADVISER_PROVIDER: "openai-decisions",
          OPENAI_API_KEY: "fixture",
        },
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array(32769));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          ),
      },
    );
    assert.deepEqual(result, {});
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2);
  }
});
