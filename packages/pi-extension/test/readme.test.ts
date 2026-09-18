// The npm tarball must ship the root README, not this package's own file on disk,
// because that's exactly what `npm publish` (CI trusted-publish or manual) and
// `npm pack` produce via the `prepack` script. Assert against the real packed
// artifact rather than the generator's output in isolation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePackageReadme } from "../../../scripts/generate-package-readme.mjs";

const PACKAGE_ROOT = join(import.meta.dirname, "..");

test("npm pack ships a README equal to the transformed root README, with no broken relative refs", (t) => {
  const destination = mkdtempSync(join(tmpdir(), "compact-adviser-pack-"));
  t.after(() => rmSync(destination, { recursive: true, force: true }));

  execFileSync("npm", ["pack", "--silent", "--pack-destination", destination], {
    cwd: PACKAGE_ROOT,
  });
  const tarball = readdirSync(destination).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not produce a .tgz");
  execFileSync("tar", ["-xzf", tarball, "-C", destination], { cwd: destination });

  const packedReadme = readFileSync(join(destination, "package", "README.md"), "utf8");
  assert.equal(packedReadme, generatePackageReadme());

  // Every relative Markdown/HTML reference the root README makes (a sibling package
  // README, SECURITY.md, the eval guide, the usage-floor image) must have become an
  // absolute GitHub URL; none of these root-relative paths exist under this package.
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
