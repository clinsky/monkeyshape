/** Every pack monkeyshape ships, by id. Shared, additions only: each pack adds its own line. */
import type { PackId } from "../schemas/config.ts";
import type { Pack } from "./pack.ts";
import { rust } from "./rust/index.ts";
import { typescript } from "./typescript/index.ts";

export const PACKS: Readonly<Partial<Record<PackId, Pack>>> = { typescript, rust };
