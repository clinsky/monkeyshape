/**
 * The Python pack's loader: ruff's and ty's own file lists, each run through uv in the repo's
 * locked environment (`uv run --frozen`, which never rewrites `uv.lock`). ruff lists what it
 * lints with `--show-files`; ty has no such flag, so its list is the files its `-vv` log says
 * it checks. Never fails: a uv, ruff or ty that can't run is an integration state.
 */
import { realpath } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { Integration, PackLoader, ToolRun } from "../../packs/pack.ts";
import { RUFF, TY } from "../../packs/python/index.ts";
import { runTool } from "../process.ts";

const NOT_SELECTED: Integration = {
  state: "unavailable",
  reason: "not run: coverage is not among the selected checks",
};

const every = (integration: Integration): ReadonlyArray<ToolRun> =>
  [RUFF, TY].map((tool) => ({ tool, integration, files: undefined }));

/** The repo-relative paths among `lines` of absolute ones under `realRoot`. */
const underRoot = (realRoot: string, paths: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(
    paths.flatMap((path) =>
      path.startsWith(`${realRoot}/`) ? [path.slice(realRoot.length + 1)] : [],
    ),
  );

/** What a `uv run` that failed says, as an integration: a missing tool is unavailable. */
const ranBadly = (tool: string, command: string, code: number, stderr: string): Integration => {
  if (/Failed to spawn: `[^`]+`/.test(stderr))
    return { state: "unavailable", reason: `${tool} isn't installed in the project's environment` };
  if (/Unable to find lockfile/.test(stderr))
    return {
      state: "failed",
      reason: `the project has no uv.lock, and \`uv run --frozen\` runs only from one: run \`uv lock\` and commit uv.lock`,
    };
  const tail = stderr.trim().split("\n").slice(-3).join(" ");
  return { state: "failed", reason: `\`${command}\` exited ${code}: ${tail}` };
};

const ruffFiles = (root: string, uv: string, realRoot: string) =>
  Effect.gen(function* () {
    const command = ["uv", "run", "--frozen", RUFF, "check", "--show-files"];
    const ran = yield* runTool(root, [uv, ...command.slice(1)]);
    if (ran.code !== 0)
      return {
        tool: RUFF,
        integration: ranBadly(RUFF, command.join(" "), ran.code, ran.stderr),
        files: undefined,
      } satisfies ToolRun;
    return {
      tool: RUFF,
      integration: { state: "ok" },
      files: underRoot(realRoot, ran.stdout.split("\n")),
    } satisfies ToolRun;
  });

const tyFiles = (root: string, uv: string, realRoot: string) =>
  Effect.gen(function* () {
    const command = ["uv", "run", "--frozen", TY, "check", "-vv", "--exit-zero"];
    const ran = yield* runTool(root, [uv, ...command.slice(1), "--output-format", "concise"]);
    if (ran.code !== 0)
      return {
        tool: TY,
        integration: ranBadly(TY, command.join(" "), ran.code, ran.stderr),
        files: undefined,
      } satisfies ToolRun;
    if (!/Indexed \d+ file/.test(ran.stderr))
      return {
        tool: TY,
        integration: {
          state: "failed",
          reason: `\`${command.join(" ")}\` logged no "Indexed N file(s)" line, so its file list can't be read: this ty logs differently from the one the Python pack reads (0.0.106)`,
        },
        files: undefined,
      } satisfies ToolRun;
    const checked = [...ran.stderr.matchAll(/Checking file '([^']+)'/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    return {
      tool: TY,
      integration: { state: "ok" },
      files: underRoot(realRoot, checked),
    } satisfies ToolRun;
  });

/** ruff and ty run only when coverage is selected, and only in a uv project. */
export const loadPython: PackLoader = ({ root, repo, checks }) =>
  Effect.gen(function* () {
    if (!checks.includes("coverage")) return { tools: every(NOT_SELECTED), outputs: new Map() };
    const hasPython = repo.files.some((file) => file.endsWith(".py") || file.endsWith(".pyi"));
    if (!repo.files.includes("pyproject.toml"))
      return {
        tools: every(
          hasPython
            ? {
                state: "failed",
                reason:
                  "the repo has Python sources but no pyproject.toml at its root; the Python pack runs ruff and ty through uv there. Make the root a uv project: `uv init --bare`, then `uv add --dev ruff ty pytest`.",
              }
            : { state: "absent" },
        ),
        outputs: new Map(),
      };
    const uv = Bun.which("uv");
    if (uv === null)
      return {
        tools: every({
          state: "unavailable",
          reason: "uv is not on the PATH",
          fix: "install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`",
        }),
        outputs: new Map(),
      };
    const realRoot = yield* Effect.promise(() => realpath(root));
    const ruff = yield* ruffFiles(root, uv, realRoot);
    const ty = yield* tyFiles(root, uv, realRoot);
    return { tools: [ruff, ty], outputs: new Map() };
  });
