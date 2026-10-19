import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AgentError } from "./errors.js";
import { withFileLock } from "./lock.js";

export const AGENT_PER_MINUTE = 6;
export const AGENT_PER_DAY = 60;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const rateSchema = z.object({
  hits: z.array(z.number().int()),
  refreshedAt: z.record(z.string(), z.number().int()),
});

type RateState = z.infer<typeof rateSchema>;

export interface RateLimiter {
  take(now: number): void;
  /** 同一订单 10 秒内只放行一次。返回 false 表示还在冷却。 */
  claimRefresh(orderId: string, now: number, cooldownMs: number): boolean;
}

export function shanghaiDayStart(now: number): number {
  return Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

export function judgeRate(hits: number[], now: number): { ok: true; hits: number[] } | { ok: false; message: string } {
  const dayStart = shanghaiDayStart(now);
  const keepAfter = Math.min(dayStart, now - MINUTE_MS);
  const kept = hits.filter((hit) => hit >= keepAfter && hit <= now);
  const minuteCount = kept.filter((hit) => now - hit < MINUTE_MS).length;
  const dayCount = kept.filter((hit) => hit >= dayStart).length;
  if (minuteCount >= AGENT_PER_MINUTE) {
    return { ok: false, message: "Agent 入口每分钟最多 6 次。不要放进定时任务、心跳或后台任务。" };
  }
  if (dayCount >= AGENT_PER_DAY) {
    return { ok: false, message: "Agent 入口每天最多 60 次（北京时间）。不要放进定时任务、心跳或后台任务。" };
  }
  return { ok: true, hits: [...kept, now] };
}

function emptyState(): RateState {
  return { hits: [], refreshedAt: {} };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export class MemoryRateLimiter implements RateLimiter {
  private state: RateState = emptyState();

  take(now: number): void {
    const judged = judgeRate(this.state.hits, now);
    if (!judged.ok) throw new AgentError("RATE_LIMITED", judged.message);
    this.state.hits = judged.hits;
  }

  claimRefresh(orderId: string, now: number, cooldownMs: number): boolean {
    const previous = this.state.refreshedAt[orderId];
    if (previous !== undefined && now - previous < cooldownMs) return false;
    this.state.refreshedAt[orderId] = now;
    return true;
  }
}

export class FileRateLimiter implements RateLimiter {
  private readonly file: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    this.file = join(dir, "agent-rate.json");
    this.lockPath = join(dir, "agent-rate.lock");
  }

  take(now: number): void {
    withFileLock(this.lockPath, () => {
      const state = this.read();
      const judged = judgeRate(state.hits, now);
      if (!judged.ok) throw new AgentError("RATE_LIMITED", judged.message);
      state.hits = judged.hits;
      writeJson(this.file, state);
    });
  }

  claimRefresh(orderId: string, now: number, cooldownMs: number): boolean {
    return withFileLock(this.lockPath, () => {
      const state = this.read();
      const previous = state.refreshedAt[orderId];
      if (previous !== undefined && now - previous < cooldownMs) return false;
      const kept: Record<string, number> = {};
      for (const [key, at] of Object.entries(state.refreshedAt)) {
        if (now - at < 60 * MINUTE_MS) kept[key] = at;
      }
      kept[orderId] = now;
      state.refreshedAt = kept;
      writeJson(this.file, state);
      return true;
    });
  }

  private read(): RateState {
    try {
      const parsed = rateSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) {
        throw new AgentError("RATE_LIMITED", "本机限速状态无法读取，已拒绝本次调用");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      throw new AgentError("RATE_LIMITED", "本机限速状态无法读取，已拒绝本次调用");
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
