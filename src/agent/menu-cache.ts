import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { QUOTE_TTL_MS } from "../core/types.js";
import { withFileLock } from "./lock.js";

const mealSchema = z.object({
  code: z.string(),
  name: z.string(),
  currentPrice: z.string(),
  originalPrice: z.string(),
});

export type MenuItem = z.infer<typeof mealSchema>;

const cacheSchema = z.object({
  entries: z.record(
    z.string(),
    z.object({
      savedAt: z.number().int(),
      meals: z.array(mealSchema),
    }),
  ),
});

type CacheFile = z.infer<typeof cacheSchema>;

export interface MenuCache {
  get(storeCode: string, now: number): MenuItem[] | undefined;
  put(storeCode: string, meals: MenuItem[], now: number): void;
}

export class MemoryMenuCache implements MenuCache {
  private readonly entries = new Map<string, { savedAt: number; meals: MenuItem[] }>();

  get(storeCode: string, now: number): MenuItem[] | undefined {
    const found = this.entries.get(storeCode);
    if (!found) return undefined;
    if (now - found.savedAt > QUOTE_TTL_MS) return undefined;
    return structuredClone(found.meals);
  }

  put(storeCode: string, meals: MenuItem[], now: number): void {
    this.entries.set(storeCode, { savedAt: now, meals: structuredClone(meals) });
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export class FileMenuCache implements MenuCache {
  private readonly file: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    this.file = join(dir, "agent-menu-cache.json");
    this.lockPath = join(dir, "agent-menu-cache.lock");
  }

  get(storeCode: string, now: number): MenuItem[] | undefined {
    const entry = this.read().entries[storeCode];
    if (!entry) return undefined;
    if (now - entry.savedAt > QUOTE_TTL_MS) return undefined;
    return entry.meals;
  }

  put(storeCode: string, meals: MenuItem[], now: number): void {
    withFileLock(this.lockPath, () => {
      const current = this.read();
      current.entries[storeCode] = { savedAt: now, meals };
      writeJson(this.file, current);
    });
  }

  private read(): CacheFile {
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) return { entries: {} };
      return parsed.data;
    } catch {
      return { entries: {} };
    }
  }
}
