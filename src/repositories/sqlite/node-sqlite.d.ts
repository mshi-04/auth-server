import type { DatabaseSync } from "node:sqlite";

// @types/node 26.6.5 does not yet declare Node 26.11's Database rename.
declare module "node:sqlite" {
  export const Database: typeof DatabaseSync;
  export type Database = DatabaseSync;
}
