#!/usr/bin/env bun
/**
 * `bun run release`: monkeyshape's own release, not a command adopters get. A release is the
 * tarball packed from the commit its tag `v<version>` names; publishing it and pushing the tag
 * are the maintainer's.
 *
 *   pack [<dir>]       the working tree, with a development version unless HEAD is the release
 *   tag [<commit>]     tag a merged commit v<its version>, recording its tarball's sha256
 *   verify <version>   pack at v<version> and compare with the tarball npm has
 */
import { Effect } from "effect";
import { run } from "../adapters/process.ts";
import {
  fetchPublished,
  fileDigest,
  packCommit,
  packSource,
  packWorkingTree,
  readTarball,
} from "../adapters/release.ts";
import { MAIN_BRANCH } from "../core/layout.ts";
import { releaseTag, tagMessage, tarballDifferences, untaggedWarning } from "../core/release.ts";
import type { WorkspaceError } from "../schemas/errors.ts";

const USAGE = `usage: bun run release pack [<dir>] | tag [<commit>] | verify <version>`;

interface Outcome {
  readonly output: string;
  readonly code: number;
}

const refuse = (reason: string): Outcome => ({ output: `release: ${reason}`, code: 1 });

const git = (repo: string, ...args: ReadonlyArray<string>) =>
  run(repo, ["git", ...args]).pipe(
    Effect.map((ran) => ({ code: ran.code, out: ran.stdout.trim(), err: ran.stderr.trim() })),
  );

const tag = (repo: string, commitArg: string, destination: string) =>
  Effect.gen(function* () {
    const commit = yield* git(repo, "rev-parse", "--verify", `${commitArg}^{commit}`);
    if (commit.code !== 0) return refuse(`${commitArg} is not a commit`);
    const shown = yield* git(repo, "show", `${commit.out}:package.json`);
    const pkg = JSON.parse(shown.out) as { name: string; version: string };
    const name = releaseTag(pkg.version);
    if (/-/.test(pkg.version))
      return refuse(`${pkg.version} is a prerelease; set the version to release in a PR first`);
    if ((yield* git(repo, "rev-parse", "--verify", "--quiet", `refs/tags/${name}`)).code === 0)
      return refuse(`${name} exists; a released version is never tagged again`);
    yield* git(repo, "fetch", "--quiet", "origin", MAIN_BRANCH);
    const merged = yield* git(
      repo,
      "merge-base",
      "--is-ancestor",
      commit.out,
      `origin/${MAIN_BRANCH}`,
    );
    if (merged.code !== 0)
      return refuse(`${commitArg} is not on origin/${MAIN_BRANCH}; release only what has merged`);
    const tarball = yield* packCommit(repo, commit.out, destination);
    // A version already on npm is tagged only where it reproduces what was published.
    const published = yield* fetchPublished(pkg.name, pkg.version, destination);
    if (published !== undefined) {
      const differences = tarballDifferences(
        yield* readTarball(tarball),
        yield* readTarball(published),
      );
      if (differences.length > 0)
        return refuse(
          [
            `${pkg.name}@${pkg.version} is published, and ${commitArg} doesn't reproduce it, so it isn't that release:`,
            ...differences.slice(0, 10).map((line) => `  ${line}`),
            ...(differences.length > 10 ? [`  and ${differences.length - 10} more`] : []),
          ].join("\n"),
        );
    }
    const digest = yield* fileDigest(tarball);
    const file = tarball.slice(tarball.lastIndexOf("/") + 1);
    const tagged = yield* git(
      repo,
      "tag",
      "--annotate",
      name,
      commit.out,
      "--message",
      tagMessage(pkg.name, pkg.version, file, digest),
    );
    if (tagged.code !== 0) return refuse(`git tag failed: ${tagged.err}`);
    return {
      output: [
        `${name} tags ${commit.out.slice(0, 7)}`,
        `${tarball}`,
        `sha256 ${digest}`,
        "",
        ...(published === undefined
          ? [
              "For the maintainer, to publish exactly this tarball:",
              `  git push origin ${name}`,
              `  bun publish ${tarball}`,
              `  bun run release verify ${pkg.version}`,
            ]
          : [
              `It reproduces ${pkg.name}@${pkg.version} as published. For the maintainer:`,
              `  git push origin ${name}`,
            ]),
      ].join("\n"),
      code: 0,
    };
  });

const verify = (repo: string, version: string, destination: string) =>
  Effect.gen(function* () {
    const name = releaseTag(version);
    if ((yield* git(repo, "rev-parse", "--verify", "--quiet", `refs/tags/${name}`)).code !== 0)
      return refuse(`no tag ${name}; run \`git fetch --tags\`, or tag it with \`release tag\``);
    const shown = yield* git(repo, "show", `${name}:package.json`);
    const pkgName = (JSON.parse(shown.out) as { name: string }).name;
    const packed = yield* readTarball(yield* packCommit(repo, name, destination));
    const fetched = yield* fetchPublished(pkgName, version, destination);
    if (fetched === undefined) return refuse(`${pkgName}@${version} is not on npm`);
    const published = yield* readTarball(fetched);
    const differences = tarballDifferences(packed, published);
    return differences.length === 0
      ? {
          output: `${name} reproduces ${pkgName}@${version}: ${packed.files.size} files, same content`,
          code: 0,
        }
      : {
          output: [
            `${name} does not reproduce ${pkgName}@${version}:`,
            ...differences.map((line) => `  ${line}`),
          ].join("\n"),
          code: 1,
        };
  });

const main = (repo: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [command, arg, ...rest] = args;
    if (rest.length > 0) return { output: USAGE, code: 2 };
    const scratch = `${repo}/.release`;
    if (command === "pack") {
      const warning = untaggedWarning(yield* packSource(repo));
      const path = yield* packWorkingTree(repo, arg ?? repo);
      // The path last, for a script that reads it.
      return {
        output: [...(warning === undefined ? [] : [`warning: ${warning}`]), path].join("\n"),
        code: 0,
      } satisfies Outcome;
    }
    if (command === "tag") return yield* tag(repo, arg ?? "HEAD", scratch);
    if (command === "verify" && arg !== undefined) return yield* verify(repo, arg, scratch);
    return { output: USAGE, code: 2 } satisfies Outcome;
  });

if (import.meta.main) {
  const outcome = await Effect.runPromise(
    main(process.cwd(), process.argv.slice(2)).pipe(
      Effect.catchTag("WorkspaceError", (error: WorkspaceError) =>
        Effect.succeed<Outcome>({ output: `release: ${error.message}`, code: 1 }),
      ),
    ),
  );
  if (outcome.code === 0) console.log(outcome.output);
  else console.error(outcome.output);
  process.exit(outcome.code);
}
