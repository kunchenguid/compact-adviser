// Live regression against the real Claude Code TUI under tmux.
//
// Claude Code runs with an isolated configuration directory, this package loaded through
// --plugin-dir, a deterministic local stand-in for the Anthropic Messages API
// (ANTHROPIC_BASE_URL), and a local TypeSafe fixture reached through the mod's
// loopback-only COMPACT_ADVISER_TEST_ENDPOINT. No account credential, model quota, or
// real TypeSafe request is used, and no user configuration is read or written.
//
// It proves:
//   1. With CLAUDE_CODE_ENABLE_FUNCTION_HOOKS unset the mod is inert: no status strip and no
//      /compact-adviser command.
//   2. With the flag on: the settings pane (an invalid minimum is refused and kept for editing,
//      a valid one is saved to the host's plugin options), and Escape closing the pane.
//   3. Two materially different settled exchanges are judged back-to-back and each shows
//      a hint, proving there is no notification cooldown between new checkpoints.
//   4. Automatic mode chosen in the pane asks for confirmation, then compacts at the next
//      eligible checkpoint; the first post-compaction exchange is still gated.
//
// COMPACT_TEST_KEEP_LAB=1 keeps the lab directory and, after a failure, the tmux session
// for ten minutes so the screen can be inspected.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE, claudeEnv, claudeVersion, PACKAGE } from "./common.mjs";

const HINT = "Potential session boundary detected. Run /compact to save tokens.";
const API_KEY = "sk-ant-fixture-not-a-real-key-0000000000";
const TYPESAFE_KEY = "tsk-live-fixture-key";
const SOCKET = `compact-adviser-e2e-${process.pid}`;
const SESSION = "e2e";
const version = claudeVersion();
const lab = realpathSync(mkdtempSync(join(tmpdir(), "compact-adviser-e2e-")));
const config = join(lab, "config");
const project = join(lab, "project");
mkdirSync(config, { recursive: true });
mkdirSync(project, { recursive: true });

// --- Local servers -----------------------------------------------------------------
const jevRequests = [];
const summaries = [];
const verdict = { completed: 0.99, handsOn: 0.99 };

function jevAnswer() {
  const choice = (name, p, others) => ({
    type: "choice",
    choice: name,
    confidence: p,
    probabilities: { [name]: p, [others[0]]: (1 - p) / 2, [others[1]]: (1 - p) / 2 },
  });
  return {
    model: "jev-1.13.0",
    answers: {
      done: choice("finished", verdict.completed, ["not_finished", "unclear"]),
      shape: choice("hands_on", verdict.handsOn, ["coordinating", "unclear"]),
    },
    usage: { input_tokens: 2500, output_tokens: 0 },
  };
}

function lastUserText(body) {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => part.text ?? "").join("\n");
}

function reply(body) {
  const text = lastUserText(body);
  if (/detailed summary|summar(y|ize) of the conversation/i.test(text)) {
    summaries.push(Date.now());
    return {
      text: "<summary>1. Primary Request and Intent: e2e fixture work, all committed. 8. Current Work: none pending.</summary>",
      input: 70000,
    };
  }
  const prompt = /E2E-PROMPT-(\d+)/.exec(text);
  if (!prompt) return { text: "ok", input: 1000 };
  const n = Number(prompt[1]);
  const long = n === 1 ? `\n\n${"Implementation notes for the parser module. ".repeat(2200)}` : "";
  return {
    text: `Done: step ${n} is implemented, 12 of 12 tests pass, and it is committed. Nothing is pending.${long}`,
    input: 70000,
  };
}

function send(res, body) {
  const { text, input } = reply(body);
  const message = {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: body.model ?? "claude-fixture",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: input,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 1 },
    },
  });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 4000) {
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: text.slice(i, i + 4000) },
    });
  }
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 40 },
  });
  event("message_stop", {});
  res.end();
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    if (req.url.startsWith("/v1/systemone")) {
      jevRequests.push({ authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jevAnswer()));
    } else if (req.url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1000 }));
    } else if (req.url.startsWith("/v1/messages")) {
      send(res, body);
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// --- Terminal helpers ----------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmux = (...args) =>
  execFileSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
const screen = () => {
  try {
    return tmux("capture-pane", "-p", "-t", SESSION);
  } catch {
    return "";
  }
};
const type = (text) => tmux("send-keys", "-t", SESSION, "-l", text);
const key = (...keys) => tmux("send-keys", "-t", SESSION, ...keys);
let step = "setup";

async function waitFor(predicate, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shot = screen();
    if (shot.includes("CLAUDE_EXIT=")) break;
    if (predicate(shot)) return shot;
    await sleep(200);
  }
  throw new Error(`[${step}] never saw ${what}\n--- screen ---\n${screen()}`);
}
const waitText = (text, timeoutMs) =>
  waitFor((s) => s.includes(text), JSON.stringify(text), timeoutMs);

async function command(text) {
  type(text);
  await sleep(400);
  key("Enter");
}

function statusLine(shot) {
  return (
    shot
      .split("\n")
      .find((line) => line.includes("compact-adviser:"))
      ?.trim() ?? ""
  );
}

function launch(flag) {
  try {
    tmux("kill-server");
  } catch {}
  const env = claudeEnv({
    CLAUDE_CONFIG_DIR: config,
    HOME: lab,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
    DISABLE_AUTOUPDATER: "1",
    TYPESAFE_API_KEY: TYPESAFE_KEY,
    COMPACT_ADVISER_TEST_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
  });
  if (!flag) delete env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
  const exports = Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${JSON.stringify(value).replace(/\$/g, "\\$")}`)
    .join(" ");
  const cmd = `env -i ${exports} ${JSON.stringify(CLAUDE)} --plugin-dir ${JSON.stringify(PACKAGE)} --model claude-sonnet-4-5 --debug-file ${JSON.stringify(join(lab, `debug-${flag ? "on" : "off"}.log`))}; echo CLAUDE_EXIT=$?; sleep 30`;
  tmux("new-session", "-d", "-s", SESSION, "-x", "140", "-y", "45", "-c", project, cmd);
}

async function ready() {
  const shot = await waitFor(
    (s) => s.includes("Do you want to use this API key") || /^❯[\s\u00a0]*$/m.test(s),
    "the prompt",
  );
  if (shot.includes("Do you want to use this API key")) {
    key("Up");
    await sleep(300);
    key("Enter");
    await waitFor((s) => /^❯[\s\u00a0]*$/m.test(s), "the prompt after approving the fixture key");
  }
}

function pluginOptions() {
  try {
    const settings = JSON.parse(readFileSync(join(config, "settings.json"), "utf8"));
    const entry = Object.entries(settings.pluginConfigs ?? {}).find(([name]) =>
      name.startsWith("compact-adviser"),
    );
    return entry?.[1]?.options ?? {};
  } catch {
    return {};
  }
}

writeFileSync(
  join(config, ".claude.json"),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: "dark",
    customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] },
    projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
);

const results = [];
function pass(message) {
  results.push(message);
  console.log(`ok - ${message}`);
}

try {
  // 1. Flag off: inert.
  step = "flag off";
  launch(false);
  await ready();
  await sleep(1500);
  if (statusLine(screen()))
    throw new Error(`[${step}] indicator shown without the flag\n${screen()}`);
  type("/compact-advis");
  await sleep(1200);
  if (screen().includes("Configure persistent compaction advice")) {
    throw new Error(`[${step}] /compact-adviser offered without the flag\n${screen()}`);
  }
  pass(`Claude Code ${version}: without CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 there is no command`);

  // 2. Flag on: command, pane, no ambient status strip.
  step = "flag on";
  launch(true);
  await ready();
  await sleep(1500);
  if (statusLine(screen()).includes("HINT · min")) {
    throw new Error(`[${step}] ambient status strip shown at idle\n${screen()}`);
  }
  await command("/compact-adviser");
  await waitText("Minimum context tokens: 40000");
  await waitText("Reset minimum to 40,000");
  if (screen().includes("TypeSafe sharing")) {
    throw new Error(`[${step}] sharing toggle still present\n${screen()}`);
  }
  pass("the settings pane opens without a sharing toggle or idle status strip");

  step = "request logging";
  key("Tab");
  for (let i = 0; i < 6 && !screen().includes("│  On"); i++) {
    await sleep(1000);
    key("Enter");
    await sleep(1000);
  }
  await waitText("│  On");
  key("Down");
  key("Enter");
  await waitText("TypeSafe request logging on (all sessions)", 20000);
  await waitFor(() => pluginOptions().logRequests === true, "the host to enable request logging");
  pass("request logging is enabled through the real settings pane");

  step = "pane minimum";
  for (let i = 0; i < 6 && !screen().includes("⏎ save"); i++) {
    await sleep(1000);
    key("Tab");
    await sleep(1000);
  }
  await waitText("⏎ save");
  for (let i = 0; i < 5; i++) key("BSpace");
  type("40k");
  await sleep(300);
  key("Enter");
  await waitText("Enter a positive whole number of tokens, for example 40000.");
  await waitText("Minimum context tokens: 40k");
  if (pluginOptions().minContextTokens !== undefined)
    throw new Error(`[${step}] an invalid minimum was saved`);
  for (let i = 0; i < 3; i++) key("BSpace");
  type("60000");
  await sleep(300);
  key("Enter");
  await waitText("Minimum context saved: 60,000 tokens");
  await waitFor(
    () => pluginOptions().minContextTokens === 60000,
    "the host to store the 60000 minimum",
  );
  await waitText("Minimum context tokens: 60000");
  pass("the pane refuses 40k, keeps it for editing, then saves 60000 to the host's plugin options");
  key("Escape");
  await waitFor((s) => !s.includes("Reset minimum to 40,000"), "Escape to close the pane");
  pass("Escape closes the settings pane");

  // 3. A judged hint.
  step = "hint";
  await command("E2E-PROMPT-1 build the parser");
  await waitText(HINT, 60000);
  if (jevRequests.length !== 1)
    throw new Error(`[${step}] expected one TypeSafe request, saw ${jevRequests.length}`);
  const request = jevRequests[0];
  if (request.authorization !== `Bearer ${TYPESAFE_KEY}` || request.body.model !== "jev-latest") {
    throw new Error(
      `[${step}] unexpected TypeSafe request ${JSON.stringify({ ...request, body: request.body.model })}`,
    );
  }
  if (JSON.stringify(request.body).includes(TYPESAFE_KEY))
    throw new Error(`[${step}] the key leaked into the body`);
  const logDir = join(lab, ".claude");
  const logNames = readdirSync(logDir).filter(
    (name) => name.startsWith("compact-adviser-requests-") && name.endsWith(".jsonl"),
  );
  if (logNames.length !== 1)
    throw new Error(`[${step}] expected one per-session request log, saw ${logNames.length}`);
  const requestLog = join(logDir, logNames[0]);
  const logLines = readFileSync(requestLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (logLines.length !== 2 || logLines[0].kind !== "request" || logLines[1].kind !== "response")
    throw new Error(`[${step}] expected correlated request and response log records`);
  const [loggedRequest, loggedResponse] = logLines;
  if (
    loggedResponse.id !== loggedRequest.id ||
    loggedResponse.answers?.done?.choice !== "finished" ||
    loggedResponse.answers?.shape?.choice !== "hands_on" ||
    typeof loggedResponse.score !== "number" ||
    typeof loggedResponse.usage !== "number" ||
    typeof loggedResponse.floor !== "number" ||
    loggedResponse.qualifies !== true
  ) {
    throw new Error(`[${step}] Jev decision log is incomplete: ${JSON.stringify(loggedResponse)}`);
  }
  if (readFileSync(requestLog, "utf8").includes(TYPESAFE_KEY))
    throw new Error(`[${step}] the TypeSafe key leaked into the request log`);
  if (process.env.COMPACT_TEST_LOG_EVIDENCE)
    copyFileSync(requestLog, process.env.COMPACT_TEST_LOG_EVIDENCE);
  pass(
    "a settled 70,000-token exchange is judged once, shows the hint, and logs its complete Jev decision without the key",
  );

  step = "back-to-back hints";
  await command("E2E-PROMPT-2 run the tests");
  await waitFor(
    (s) => jevRequests.length === 2 && statusLine(s).includes(HINT),
    "a second immediate judgment and hint at the new checkpoint",
    60000,
  );
  pass("a materially different next checkpoint is judged immediately and shows another hint");

  // 4. Automatic mode through the pane, then one compaction and its retained wait gate.
  step = "auto";
  await command("/compact-adviser");
  await waitText("Mode: Hints only (default)");
  // A key sent while the surface is still settling the pane's focus can be dropped, so
  // open the picker with one Enter at a time until it shows its options.
  for (let i = 0; i < 6 && !screen().includes("Automatic (experimental)"); i++) {
    await sleep(1000);
    key("Enter");
    await sleep(1000);
  }
  await waitText("Automatic (experimental)");
  key("Down");
  await sleep(200);
  key("Enter");
  await waitText("Compaction is lossy");
  await waitText("Enable automatic mode");
  key("Enter");
  await waitText("Automatic mode saved (all sessions)", 20000);
  await waitFor(() => pluginOptions().mode === "auto", "the host to store auto mode");
  // The confirmation dialog and hot reload can drop an Escape or return focus to an Input,
  // where Escape only blurs it. Send one at a time and stop as soon as the pane closes so an
  // extra Escape cannot open Claude's Rewind dialog.
  for (let attempt = 0; attempt < 6 && screen().includes("Reset minimum to 40,000"); attempt++) {
    key("Escape");
    const closeDeadline = Date.now() + 3000;
    while (screen().includes("Reset minimum to 40,000") && Date.now() < closeDeadline) {
      await sleep(200);
    }
  }
  await waitFor((s) => !s.includes("Reset minimum to 40,000"), "the pane to close");
  pass("automatic mode chosen in the pane asks first, then persists");

  await command("E2E-PROMPT-3 add docs");
  await waitText("compact-adviser: automatic compaction completed:", 90000);
  if (jevRequests.length !== 3)
    throw new Error(`[${step}] expected the new checkpoint to be judged immediately`);
  if (summaries.length !== 1)
    throw new Error(`[${step}] expected one summarization, saw ${summaries.length}`);
  pass("automatic mode compacts at the next eligible checkpoint through Claude Code's compaction");

  step = "post-compaction wait";
  await command("E2E-PROMPT-4 final check");
  await waitText("Done: step 4", 60000);
  await sleep(3000);
  if (jevRequests.length !== 3)
    throw new Error(`[${step}] post-compaction exchange bypassed the retained wait gate`);
  if (summaries.length !== 1) throw new Error(`[${step}] a second compaction ran`);
  pass("the first post-compaction exchange remains gated and does not judge or compact again");
  console.log(`\n${results.length} live checks passed on Claude Code ${version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (process.env.COMPACT_TEST_KEEP_LAB && process.exitCode) {
    console.error(`lab kept at ${lab}; tmux -L ${SOCKET} attach -t ${SESSION}; waiting 10 minutes`);
    await sleep(600000);
  }
  try {
    tmux("kill-server");
  } catch {}
  server.close();
  if (process.env.COMPACT_TEST_KEEP_LAB) console.error(`lab kept at ${lab}`);
  else rmSync(lab, { recursive: true, force: true });
}
