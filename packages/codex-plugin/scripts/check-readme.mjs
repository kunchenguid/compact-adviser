// This package has no publish/pack step (it's distributed as a Codex plugin
// through the marketplace, which reads the committed README.md directly), so the
// committed file itself must equal the shared generator's output. Runs as plain
// node, not under `claude plugin test`, so it can read the root README with node:fs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatePackageReadme } from "../../../scripts/generate-package-readme.mjs";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const committed = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
const generated = generatePackageReadme();

assert.equal(
  committed,
  generated,
  "packages/codex-plugin/README.md has drifted from the root README. Run `npm run sync-readmes` from the repo root and commit the result.",
);

for (const brokenRef of ["](packages/", "](SECURITY.md)", "](docs/", 'href="LICENSE"']) {
  assert.ok(
    !committed.includes(brokenRef),
    `committed README still has a broken ref: ${brokenRef}`,
  );
}

console.log("packages/codex-plugin/README.md matches the transformed root README.");
