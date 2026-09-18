// Live regression against the real Codex CLI under tmux.
//
// Codex runs with an isolated CODEX_HOME, this package installed the way a user installs it
// (a marketplace source plus `codex plugin add`), a deterministic local stand-in for the model
// provider, and a local TypeSafe fixture reached through the plugin's loopback-only
// COMPACT_ADVISER_TEST_ENDPOINT. No account credential, model quota, or real TypeSafe request
// is used, and no user configuration is read or written.
//
// It proves:
//   1. The package installs as a Codex plugin from a marketplace and reports itself installed.
//   2. A settled, large-enough exchange in the TUI is judged once and paints the hint as the
//      `↳ Hook ·` scrollback line, logging the complete Jev decision without the key.
//   3. `codex exec` settles the same session shape without judging: scripted runs never advise.
//   4. A materially different next checkpoint is judged again immediately.
//   5. The settings CLI turns the adviser off, and the next checkpoint is then left alone.
//
// COMPACT_TEST_KEEP_LAB=1 keeps the lab directory and, after a failure, the tmux session for
// ten minutes so the screen can be inspected.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "..", "..");
const CODEX = process.env.COMPACT_TEST_CODEX_BIN || "codex";
const HINT = "Compact adviser: work appears completed or recorded. Run /compact to save tokens.";
const TYPESAFE_KEY = "tsk-live-fixture-key";
const SOCKET = `compact-adviser-codex-e2e-${process.pid}`;
const SESSION = "e2e";

const lab = realpathSync(mkdtempSync(join(tmpdir(), "compact-adviser-codex-e2e-")));
const home = join(lab, "codex-home");
const project = join(lab, "project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(project, ".env"), `TYPESAFE_API_KEY=${TYPESAFE_KEY}\n`);

const version = run([CODEX, "--version"]).stdout.trim();

// --- Local servers -------------------------------------------------------------------
const jevRequests = [];
let modelRequests = 0;

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
      done: choice("finished", 0.99, ["not_finished", "unclear"]),
      shape: choice("hands_on", 0.99, ["coordinating", "unclear"]),
    },
    usage: { input_tokens: 2500, output_tokens: 0 },
  };
}

/** A settled answer, long enough that the conversation clears the 20,000-token gate. */
function modelReply(body) {
  const asked = JSON.stringify(body.input ?? body.messages ?? "");
  const step = /E2E-PROMPT-(\d+)/.exec(asked)?.[1] ?? "0";
  const filler = "Implementation notes for the parser module. ".repeat(2600);
  return `Done: step ${step} is implemented, 12 of 12 tests pass, and it is committed. Nothing is pending.\n\n${filler}`;
}

const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    if (request.url.startsWith("/v1/systemone")) {
      jevRequests.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(jevAnswer()));
      return;
    }
    if (!request.url.includes("/responses")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    modelRequests++;
    const text = modelReply(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("response.created", { response: { id: "resp_1" } });
    event("response.output_item.done", {
      output_index: 0,
      item: {
        id: `msg_${jevRequests.length}_${Date.now()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    });
    event("response.completed", {
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 70000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 70050,
        },
      },
    });
    response.end();
  });
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;

// --- Helpers -------------------------------------------------------------------------
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(argv, options = {}) {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    // Closed stdin: `codex exec` otherwise waits to read an extra prompt from it.
    input: "",
    cwd: options.cwd ?? lab,
    env: { ...process.env, CODEX_HOME: home, ...options.env },
    timeout: options.timeoutMs ?? 120000,
  });
  if (result.error) {
    throw new Error(
      `${argv.join(" ")} failed: ${result.error.message}\n--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

/**
 * Runs a command without blocking this process: the fixture servers above live on this event
 * loop, so a synchronous child that talks to them would deadlock waiting for an answer this
 * process cannot give while it is blocked.
 */
function runAsync(argv, options = {}) {
  const [command, ...args] = argv;
  return new Promise((settle, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? lab,
      env: { ...process.env, CODEX_HOME: home, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 180000);
    child.on("error", fail);
    child.on("close", (status) => {
      clearTimeout(timer);
      settle({ status, stdout, stderr });
    });
  });
}

const providerConfig = [
  "-c",
  "model_providers.fixture.name=fixture",
  "-c",
  `model_providers.fixture.base_url=http://127.0.0.1:${port}/v1`,
  "-c",
  "model_providers.fixture.wire_api=responses",
  "-c",
  "model_providers.fixture.env_key=FIXTURE_KEY",
  "-c",
  "model_provider=fixture",
  "-c",
  "model=gpt-fixture",
];

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

async function waitFor(predicate, what, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shot = screen();
    if (shot.includes("CODEX_EXIT=")) break;
    if (predicate(shot)) return shot;
    await sleep(200);
  }
  throw new Error(`[${step}] never saw ${what}\n--- screen ---\n${screen()}`);
}
const waitText = (text, timeoutMs) =>
  waitFor((shot) => shot.includes(text), JSON.stringify(text), timeoutMs);

function launch() {
  try {
    tmux("kill-server");
  } catch {}
  const env = {
    PATH: process.env.PATH,
    HOME: lab,
    TERM: "xterm-256color",
    CODEX_HOME: home,
    FIXTURE_KEY: "fixture",
    COMPACT_ADVISER_TEST_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
    // Codex rebuilds a hook's PATH from a shell snapshot, and this lab HOME has no shell
    // profile at all; the documented override pins the hook to the Node running this suite.
    COMPACT_ADVISER_NODE: process.execPath,
  };
  const exports = Object.entries(env)
    .map(([name, value]) => `${name}=${JSON.stringify(value).replace(/\$/g, "\\$")}`)
    .join(" ");
  const argv = ["--dangerously-bypass-hook-trust", "-s", "read-only", ...providerConfig]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
  const command = `env -i ${exports} ${JSON.stringify(CODEX)} ${argv}; echo CODEX_EXIT=$?; sleep 30`;
  tmux("new-session", "-d", "-s", SESSION, "-x", "160", "-y", "50", "-c", project, command);
}

async function ask(prompt) {
  type(prompt);
  await sleep(400);
  key("Enter");
}

function hintLines(shot) {
  return shot.split("\n").filter((line) => line.includes(HINT));
}

function requestLog() {
  const directory = join(home, "compact-adviser", "requests");
  const names = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  if (names.length !== 1) throw new Error(`expected one request log, saw ${names.join(", ")}`);
  const raw = readFileSync(join(directory, names[0]), "utf8");
  return {
    raw,
    lines: raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

const cli = (...args) =>
  run([process.execPath, join(PACKAGE, "src", "cli.ts"), ...args], { cwd: project });

const results = [];
function pass(message) {
  results.push(message);
  console.log(`ok - ${message}`);
}

try {
  // 1. Install the way a user does.
  step = "install";
  execFileSync("git", ["init", "-q"], { cwd: project });
  const added = run([CODEX, "plugin", "marketplace", "add", REPO]);
  if (added.status !== 0) throw new Error(`marketplace add failed: ${added.stderr}`);
  const installed = run([CODEX, "plugin", "add", "compact-adviser@compact-adviser"]);
  if (installed.status !== 0) throw new Error(`plugin add failed: ${installed.stderr}`);
  const listed = run([CODEX, "plugin", "list"]).stdout;
  if (!/compact-adviser@compact-adviser\s+installed, enabled/.test(listed)) {
    throw new Error(`plugin not installed and enabled:\n${listed}`);
  }
  pass(`Codex ${version}: the package installs from a marketplace as an enabled plugin`);

  step = "settings cli";
  const logOn = cli("log", "on");
  if (logOn.status !== 0 || !logOn.stdout.includes("logging on")) {
    throw new Error(`the settings CLI did not enable logging: ${logOn.stdout}${logOn.stderr}`);
  }
  const refused = cli("auto");
  if (refused.status === 0 || !refused.stderr.includes("not available on Codex")) {
    throw new Error(
      `the settings CLI did not refuse auto mode: ${refused.stdout}${refused.stderr}`,
    );
  }
  pass("the settings CLI saves a setting and refuses automatic mode, which Codex cannot do");

  // 3. A scripted run settles without judging, before any TUI is up to interleave with it.
  step = "codex exec";
  const before = jevRequests.length;
  const exec = await runAsync(
    [
      CODEX,
      "exec",
      "--dangerously-bypass-hook-trust",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      ...providerConfig,
      "E2E-PROMPT-3 summarize",
    ],
    {
      cwd: project,
      env: {
        FIXTURE_KEY: "fixture",
        COMPACT_ADVISER_TEST_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
        COMPACT_ADVISER_NODE: process.execPath,
      },
    },
  );
  if (exec.status !== 0) throw new Error(`[${step}] codex exec failed: ${exec.stderr}`);
  if (exec.stdout.includes(HINT)) throw new Error(`[${step}] a scripted run showed the hint`);
  if (jevRequests.length !== before) {
    throw new Error(`[${step}] a scripted run asked TypeSafe ${jevRequests.length - before} times`);
  }
  pass("codex exec settles the same shape without judging: scripted runs never advise");

  // 2. A judged hint in the real TUI.
  step = "hint";
  launch();
  await waitFor(
    (shot) => shot.includes("Do you trust") || shot.includes("Ask Codex to do anything"),
    "the composer",
  );
  if (screen().includes("Do you trust")) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const shot = screen();
      if (shot.includes("Ask Codex to do anything")) break;
      // The trust dialog can be painted before the TUI accepts keyboard input.
      if (shot.includes("Do you trust")) key("Enter");
      await sleep(300);
    }
    await waitText("Ask Codex to do anything");
  }
  await ask("E2E-PROMPT-1 build the parser");
  const shot = await waitText(HINT, 90000);
  const lines = hintLines(shot);
  if (lines.length !== 1 || !lines[0].trim().startsWith("↳ Hook ·")) {
    throw new Error(`[${step}] expected one '↳ Hook ·' hint line\n${shot}`);
  }
  if (jevRequests.length !== 1) {
    throw new Error(`[${step}] expected one TypeSafe request, saw ${jevRequests.length}`);
  }
  const [request] = jevRequests;
  if (request.authorization !== `Bearer ${TYPESAFE_KEY}` || request.body.model !== "jev-latest") {
    throw new Error(`[${step}] unexpected TypeSafe request ${JSON.stringify(request.body.model)}`);
  }
  if (JSON.stringify(request.body).includes(TYPESAFE_KEY)) {
    throw new Error(`[${step}] the key leaked into the body`);
  }
  const log = requestLog();
  const [loggedRequest, loggedResponse] = log.lines;
  if (
    log.lines.length !== 2 ||
    loggedRequest.kind !== "request" ||
    loggedResponse.kind !== "response" ||
    loggedResponse.id !== loggedRequest.id ||
    loggedResponse.answers?.done?.choice !== "finished" ||
    loggedResponse.answers?.shape?.choice !== "hands_on" ||
    typeof loggedResponse.score !== "number" ||
    typeof loggedResponse.floor !== "number" ||
    loggedResponse.qualifies !== true
  ) {
    throw new Error(`[${step}] Jev decision log is incomplete: ${JSON.stringify(log.lines)}`);
  }
  if (log.raw.includes(TYPESAFE_KEY)) {
    throw new Error(`[${step}] the TypeSafe key leaked into the request log`);
  }
  pass(
    "a settled 70,000-token exchange is judged once, paints the ↳ Hook hint, and logs its complete Jev decision without the key",
  );

  step = "back-to-back hints";
  await ask("E2E-PROMPT-2 run the tests");
  // The answer is long enough to scroll the first hint away, so this is the hint under the
  // new answer, not the old one still on screen.
  await waitFor(
    (shot) => jevRequests.length === 2 && hintLines(shot).length === 1,
    "a second immediate judgment and hint at the new checkpoint",
    90000,
  );
  pass("a materially different next checkpoint is judged immediately and shows another hint");

  // 5. Off means off.
  step = "off";
  const off = cli("off");
  if (off.status !== 0 || !off.stdout.includes("Off saved")) {
    throw new Error(`[${step}] the settings CLI did not save off: ${off.stdout}${off.stderr}`);
  }
  const requestsBeforeOff = jevRequests.length;
  const answersBeforeOff = modelRequests;
  await ask("E2E-PROMPT-4 add docs");
  // The answer is far taller than the pane, so wait on the model call rather than its text.
  await waitFor(() => modelRequests > answersBeforeOff, "the next answer", 90000);
  await sleep(6000);
  if (jevRequests.length !== requestsBeforeOff) {
    throw new Error(`[${step}] a checkpoint was judged with the adviser off`);
  }
  if (hintLines(screen()).length !== 0) throw new Error(`[${step}] a new hint appeared while off`);
  pass("with the adviser off a settled checkpoint is neither judged nor hinted");

  console.log(`\n${results.length} live checks passed on Codex ${version}.`);
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
  else rmSync(lab, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
