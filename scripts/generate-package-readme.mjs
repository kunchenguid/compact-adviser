#!/usr/bin/env node
// Single source of truth for all package READMEs: the root README.md, with its
// relative links/images rewritten to absolute GitHub URLs so they still resolve when
// the same text is read from a package directory (npm or marketplace/GitHub), which
// does not sit next to the files the root README points at (docs/, SECURITY.md, ...).
//
// Used by:
//   - packages/pi-extension's `prepack` script, so every `npm pack`/`npm publish`
//     (CI trusted-publish or manual) ships a freshly generated README in the tarball.
//   - the marketplace packages' `check-readme` scripts and pi-extension's
//     `test/readme.test.ts`, which fail the build if the committed/packed README has
//     drifted from what this generator produces.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Not derived from `git branch --show-current`: release-please's publish job checks
// out a tag (detached HEAD), where that would report nothing useful. The repo's
// default branch is pinned here instead.
const DEFAULT_BRANCH = "main";

function repoSlug() {
  // The root package.json is private and unpublished, so it carries no
  // `repository` field; the published pi-extension manifest is the canonical source.
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages/pi-extension/package.json"), "utf8"),
  );
  const match = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/.exec(pkg.repository?.url ?? "");
  if (!match)
    throw new Error("packages/pi-extension/package.json repository.url is not a github.com URL");
  return match[1];
}

const SKIP_TARGET = /^([a-z][a-z0-9+.-]*:|#)/i;

function absoluteUrl(relativePath, { image }) {
  const clean = relativePath.replace(/^\.\//, "").replace(/^\//, "");
  const base = image
    ? `https://raw.githubusercontent.com/${repoSlug()}/${DEFAULT_BRANCH}/`
    : `https://github.com/${repoSlug()}/blob/${DEFAULT_BRANCH}/`;
  return base + clean;
}

/** Rewrite every root-relative Markdown link/image and HTML href/src to an absolute GitHub URL. */
export function generatePackageReadme(rootReadme) {
  const source = rootReadme ?? readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  return source
    .replace(
      /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\)/g,
      (whole, bang, text, target, title) => {
        if (SKIP_TARGET.test(target)) return whole;
        const url = absoluteUrl(target, { image: bang === "!" });
        return title ? `${bang}[${text}](${url} ${title})` : `${bang}[${text}](${url})`;
      },
    )
    .replace(/\b(href|src)=(?:"([^"]*)"|'([^']*)')/g, (whole, attr, double, single) => {
      const quote = double !== undefined ? '"' : "'";
      const target = double ?? single;
      if (SKIP_TARGET.test(target)) return whole;
      return `${attr}=${quote}${absoluteUrl(target, { image: attr === "src" })}${quote}`;
    });
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const content = generatePackageReadme();
  const outArg = process.argv[2];
  if (!outArg) process.stdout.write(content);
  else writeFileSync(path.resolve(process.cwd(), outArg), content);
}
