import { defineConfig } from "./src/api/monkeyshape.ts";
import { DEFAULT_DOCS } from "./src/schemas/config.ts";

export default defineConfig({
  arch: {
    modules: {
      schemas: { description: "Config schema and tagged errors: pure data contracts." },
      helpers: { description: "Runtime helpers adopters import, e.g. decodeStrict." },
      core: {
        description: "Every check, as pure functions over a Snapshot. No host I/O.",
        mayImport: ["schemas"],
        packages: ["oxc-parser"],
      },
      adapters: {
        description: "Loads the repo, the config and the baseline from disk and git.",
        mayImport: ["schemas", "helpers", "core"],
        hostAccess: true,
      },
      api: {
        description: "The package's public surface.",
        mayImport: ["schemas", "helpers"],
      },
      cli: {
        description: "The mshape executable and composition root.",
        mayImport: ["schemas", "core", "adapters"],
        hostAccess: true,
        manifest: true,
      },
    },
  },
  // The adopters' guide ships in the package, not in their repos, so only this repo checks it.
  refs: { docs: [...DEFAULT_DOCS, "docs/workflow.md"] },
});
