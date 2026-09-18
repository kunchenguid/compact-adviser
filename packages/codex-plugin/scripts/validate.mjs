// What Codex is handed when this plugin is installed, checked the way Codex reads it.
//
// A Codex plugin is copied into the user's plugin cache and run from there: no install step,
// no node_modules, no build. So the manifests must point at files that exist, every hook
// command must resolve through ${PLUGIN_ROOT}, the sources must import nothing but each other
// and Node built-ins, and both entry points must run under a bare `node` and answer JSON.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_EVENTS = ["Stop", "PreCompact", "PostCompact", "SessionStart"];
const problems = [];

function fail(message) {
  problems.push(message);
}

function readJson(relative) {
  try {
    return JSON.parse(readFileSync(join(PACKAGE, relative), "utf8"));
  } catch (error) {
    fail(`${relative} is missing or not valid JSON: ${error.message}`);
    return undefined;
  }
}

const manifest = readJson(".codex-plugin/plugin.json");
if (manifest) {
  for (const field of ["name", "version", "description", "license"]) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") {
      fail(`.codex-plugin/plugin.json is missing ${field}`);
    }
  }
  if (manifest.name !== "compact-adviser") fail("the plugin name must stay compact-adviser");
  if (typeof manifest.author?.name !== "string") fail("plugin.json needs author.name");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) fail("plugin.json version must be semver");
  for (const [field, path] of [
    ["hooks", manifest.hooks],
    ["skills", manifest.skills],
  ]) {
    if (typeof path !== "string" || !path.startsWith("./")) {
      fail(`plugin.json ${field} must be a relative "./" path`);
    } else if (!existsSync(join(PACKAGE, path))) {
      fail(`plugin.json ${field} points at ${path}, which does not exist`);
    }
  }
  // Codex would load it, but a plugin that can trigger nothing must not claim it can.
  if (JSON.stringify(manifest).includes('"auto"')) fail("plugin.json must not advertise auto mode");
}

const hooks = readJson("hooks/hooks.json");
if (hooks) {
  const registered = Object.keys(hooks.hooks ?? {});
  for (const event of HOOK_EVENTS) {
    if (!registered.includes(event)) fail(`hooks.json does not register ${event}`);
  }
  for (const event of registered) {
    if (!HOOK_EVENTS.includes(event)) fail(`hooks.json registers an unexpected event: ${event}`);
    for (const group of hooks.hooks[event] ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== "command") fail(`${event} uses an unsupported hook type ${hook.type}`);
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Codex's own placeholder syntax.
        if (!hook.command?.includes("${PLUGIN_ROOT}")) {
          fail(`${event} command does not resolve through \${PLUGIN_ROOT}: ${hook.command}`);
        }
        for (const [, target] of (hook.command ?? "").matchAll(/\$\{PLUGIN_ROOT\}\/([^"']+)/g)) {
          if (!existsSync(join(PACKAGE, target))) {
            fail(`${event} command names ${target}, which this package does not ship`);
          }
        }
        // Never a bare `node`: Codex rebuilds the hook's PATH and may not have one.
        if (/^\s*node\b/.test(hook.command ?? "")) {
          fail(`${event} command runs \`node\` directly instead of hooks/run.sh`);
        }
        if (typeof hook.timeout !== "number") fail(`${event} command has no timeout`);
      }
    }
  }
}

function runNode(args, input) {
  return spawnSync(process.execPath, args, {
    input,
    encoding: "utf8",
    cwd: PACKAGE,
    env: { ...process.env, CODEX_HOME: join(PACKAGE, "node_modules", ".validate-home") },
    timeout: 30000,
  });
}

// The real entry points, run the way Codex and the settings skill run them: plain `node`
// against the TypeScript sources, which only works while they stay erasable.
const hook = runNode(
  [join(PACKAGE, "src", "hook.ts")],
  JSON.stringify({ hook_event_name: "Stop" }),
);
if (hook.status !== 0) fail(`src/hook.ts exited ${hook.status}: ${hook.stderr}`);
if (hook.stderr.trim() !== "") fail(`src/hook.ts wrote to stderr: ${hook.stderr}`);
if (hook.stdout.trim() !== "{}") fail(`src/hook.ts answered ${hook.stdout}, expected {}`);

const cli = runNode([join(PACKAGE, "src", "cli.ts"), "status"], "");
if (cli.status !== 0) fail(`src/cli.ts exited ${cli.status}: ${cli.stderr}`);
if (!cli.stdout.includes("Mode: hint")) fail(`src/cli.ts status answered ${cli.stdout}`);

if (problems.length > 0) {
  console.error(`Codex plugin package is not loadable as shipped:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Codex plugin manifests, dependency-free sources, and both entry points validated on ${process.version}.`,
);
