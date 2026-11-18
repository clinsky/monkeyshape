/** Every pack's loader, by id. Shared, additions only: each pack adds its own line. */
import type { PackLoader } from "../../packs/pack.ts";
import type { PackId } from "../../schemas/config.ts";
import { loadRust } from "./rust.ts";
import { loadTypescript } from "./typescript.ts";

export const LOADERS: Readonly<Partial<Record<PackId, PackLoader>>> = {
  typescript: loadTypescript,
  rust: loadRust,
};
