import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function repoPath(...parts: string[]): string {
  return join(here, "..", "..", ...parts);
}

export function fixturePath(...parts: string[]): string {
  return repoPath("fixtures", ...parts);
}
