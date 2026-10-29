import { defineConfig } from "monkeyshape";

export default defineConfig({
  // The module map is the layout: every directory under src/ is a module, and nothing else
  // restates it. Add modules as the code grows; `mshape check` keeps imports to these edges.
  arch: {
    modules: {
      core: { description: "Deterministic logic over plain data. No host I/O." },
      adapters: {
        description: "Host I/O (disk, network, processes) behind services.",
        mayImport: ["core"],
        hostAccess: true,
      },
      cli: {
        description: "The entry point and composition root: where effects run.",
        mayImport: ["core", "adapters"],
        hostAccess: true,
      },
    },
  },
  tracks: {
    // Gitignored data every track worktree shares with the main checkout, such as a large
    // dataset: repo-relative paths like "data/large". `mshape track new` links each one.
    sharedPaths: [],
  },
});
