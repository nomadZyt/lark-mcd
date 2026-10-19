import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fixturePath } from "../core/paths.js";
import type { OrderItem, WithOrderArg } from "../core/types.js";

const withOrderSchema = z
  .object({
    cardId: z.string().optional(),
    cardType: z.number().optional(),
    membershipCode: z.string().optional(),
    membershipSpecId: z.string().optional(),
  })
  .strict();

const itemSchema = z.object({
  productCode: z.string(),
  quantity: z.number().int().positive(),
  name: z.string().optional(),
  canWithOrder: z.boolean().optional(),
  discountType: z.string().optional(),
  withOrder: withOrderSchema.optional(),
  originalPriceYuan: z.string().optional(),
  memberPriceYuan: z.string().optional(),
});

const stateSchema = z.object({
  store: z
    .object({
      storeCode: z.string(),
      storeName: z.string(),
      city: z.string().optional(),
      keyword: z.string().optional(),
    })
    .optional(),
  favorite: z
    .object({
      savedAt: z.string(),
      items: z.array(itemSchema),
    })
    .optional(),
  lastPrice: z
    .object({
      fen: z.number().int(),
      savedAt: z.string(),
      note: z.string(),
    })
    .optional(),
});

export type AppState = z.infer<typeof stateSchema>;

export interface StateStore {
  load(): AppState;
  save(next: AppState): void;
}

export function defaultStatePath(): string {
  return join(homedir(), ".lark-mcd", "state.json");
}

export class MemoryStateStore implements StateStore {
  constructor(private current: AppState = {}) {}

  load(): AppState {
    return structuredClone(this.current);
  }

  save(next: AppState): void {
    this.current = structuredClone(next);
  }
}

export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}

  load(): AppState {
    try {
      return parseState(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  save(next: AppState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
}

export function parseState(raw: string): AppState {
  const json: unknown = JSON.parse(raw);
  const record = json && typeof json === "object" ? { ...(json as Record<string, unknown>) } : {};
  delete record._notice;
  const parsed = stateSchema.safeParse(record);
  if (!parsed.success) return {};
  return parsed.data;
}

export function loadDemoState(): AppState {
  return parseState(readFileSync(fixturePath("demo-state.json"), "utf8"));
}

export function itemsFromState(items: z.infer<typeof itemSchema>[]): OrderItem[] {
  return items.map((item) => ({
    ...item,
    withOrder: item.withOrder as WithOrderArg | undefined,
  }));
}
