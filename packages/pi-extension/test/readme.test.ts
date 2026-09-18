// The committed package README must already match the transformed root README.
// Check that first: `prepack` overwrites the file, so inspecting only the packed
// artifact would mask a stale committed copy. Then assert the npm tarball ships
// the same README, because that's what `npm publish` (CI trusted-publish or
// manual) and `npm pack` produce via the `prepack` script.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePackageReadme } from "../../../scripts/generate-package-readme.mjs";

const PACKAGE_ROOT = join(import.meta.dirname, "..");

test("committed and packed READMEs equal the transformed root README, with no broken relative refs", (t) => {
  const expected = generatePackageReadme();
  const committedReadme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
  assert.equal(
    committedReadme,
    expected,
    "packages/pi-extension/README.md has drifted from the root README. Run `npm run sync-readmes` from the repo root and commit the result.",
  );

  const destination = mkdtempSync(join(tmpdir(), "compact-adviser-pack-"));
  t.after(() => rmSync(destination, { recursive: true, force: true }));

  execFileSync("npm", ["pack", "--silent", "--pack-destination", destination], {
    cwd: PACKAGE_ROOT,
  });
  const tarball = readdirSync(destination).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not produce a .tgz");
  execFileSync("tar", ["-xzf", tarball, "-C", destination], { cwd: destination });

  const packedReadme = readFileSync(join(destination, "package", "README.md"), "utf8");
  assert.equal(packedReadme, expected);

  // Every relative Markdown/HTML reference the root README makes (including package
  // docs, security guidance, and images) must become an absolute GitHub URL; none of
  // these root-relative paths exist under this package.
  for (const brokenRef of ["](packages/", "](SECURITY.md)", "](docs/", 'href="LICENSE"'] as const) {
    assert.ok(
      !packedReadme.includes(brokenRef),
      `packed README still has a broken ref: ${brokenRef}`,
    );
  }
  assert.match(
    packedReadme,
    /https:\/\/raw\.githubusercontent\.com\/kunchenguid\/compact-adviser\/main\/docs\/eval-usage-floor-curve\.png/,
  );
});

test("rewrites titled Markdown refs and single-quoted HTML attrs to absolute GitHub URLs", () => {
  const out = generatePackageReadme(
    [
      '[Security](SECURITY.md "Policy")',
      "[Eval](packages/pi-extension/eval/README.md)",
      "<a href='LICENSE'>License</a>",
      '<a href="LICENSE">License</a>',
      '[Jev](https://typesafe.ai "Docs")',
      "[Frag](#section)",
      '![curve](docs/eval-usage-floor-curve.png "Floor")',
    ].join("\n"),
  );

  assert.equal(
    out,
    [
      '[Security](https://github.com/kunchenguid/compact-adviser/blob/main/SECURITY.md "Policy")',
      "[Eval](https://github.com/kunchenguid/compact-adviser/blob/main/packages/pi-extension/eval/README.md)",
      "<a href='https://github.com/kunchenguid/compact-adviser/blob/main/LICENSE'>License</a>",
      '<a href="https://github.com/kunchenguid/compact-adviser/blob/main/LICENSE">License</a>',
      '[Jev](https://typesafe.ai "Docs")',
      "[Frag](#section)",
      '![curve](https://raw.githubusercontent.com/kunchenguid/compact-adviser/main/docs/eval-usage-floor-curve.png "Floor")',
    ].join("\n"),
  );
});
