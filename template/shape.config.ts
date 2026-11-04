import { defineConfig } from "monkeyshape";

export default defineConfig({
  // The module map is the layout: every directory under src/ is a module, and nothing else
  // restates it. Add modules as the code grows; `mshape check` keeps imports to these edges.
  // `optional: true` is for a module with no code yet: drop it once the directory has some,
  // so a module renamed or emptied later fails instead of passing over nothing.
  arch: {
    modules: {
      core: { description: "Deterministic logic over plain data. No host I/O.", optional: true },
      adapters: {
        description: "Host I/O (disk, network, processes) behind services.",
        mayImport: ["core"],
        hostAccess: true,
        optional: true,
      },
      cli: {
        description: "The entry point and composition root: where effects run.",
        mayImport: ["core", "adapters"],
        hostAccess: true,
        optional: true,
      },
    },
  },
  tracks: {
    // Gitignored data every track worktree shares with the main checkout, such as a large
    // dataset: repo-relative paths like "data/large". `mshape track new` links each one.
    sharedPaths: [],
  },
});
