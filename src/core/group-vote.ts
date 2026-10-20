import { yuanStringToFen } from "./money.js";
import type { MealInfo } from "./types.js";

/** 一场群拼单最多 10 份。一家店、一个时段。 */
export const GROUP_PORTION_CAP = 10;

export const GROUP_SCENES = ["午餐", "加班餐", "团队活动", "其他"] as const;
export type GroupScene = (typeof GROUP_SCENES)[number];

export interface Candidate {
  productCode: string;
  name: string;
  referenceFen: number;
}

export interface VoteLine {
  openId: string;
  displayName: string;
  productCode: string;
  quantity: number;
}

export interface GroupVote {
  id: string;
  chatId: string;
  ownerOpenId: string;
  storeCode: string;
  storeName: string;
  scene: GroupScene;
  slot: string;
  candidates: Candidate[];
  lines: VoteLine[];
  status: "open" | "priced" | "rehearsed" | "ordered" | "cancelled";
}

export type TickResult = { ok: true; lines: VoteLine[] } | { ok: false; reason: string };

export function isGroupScene(value: string): value is GroupScene {
  return (GROUP_SCENES as readonly string[]).includes(value);
}

export function totalPortions(lines: readonly { quantity: number }[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function displayNameFromOpenId(openId: string, given?: string): string {
  const name = given?.trim();
  if (name) return name.slice(0, 20);
  return `成员${openId.slice(-4)}`;
}

/**
 * 成员改自己的份数。只动本地选票，不产生任何 MCP 参数。
 * 随单购商品不进候选；参考价用原价或现价，并在卡片上标明参考价。
 */
export function applyTick(
  vote: Pick<GroupVote, "status" | "candidates" | "lines">,
  input: { openId: string; displayName: string; productCode: string; delta: number },
): TickResult {
  if (vote.status !== "open") return { ok: false, reason: "发起人已经截止，不能再改份数" };
  if (!vote.candidates.some((candidate) => candidate.productCode === input.productCode)) {
    return { ok: false, reason: "这份餐品不在本场候选里" };
  }
  if (input.delta !== 1 && input.delta !== -1) return { ok: false, reason: "份数一次只能改 1" };
  const lines = vote.lines.map((line) => ({ ...line }));
  const index = lines.findIndex((line) => line.openId === input.openId && line.productCode === input.productCode);
  const current = index >= 0 ? lines[index]!.quantity : 0;
  const next = current + input.delta;
  if (next < 0) return { ok: false, reason: "这份已经是 0" };
  const others = totalPortions(lines.filter((_, lineIndex) => lineIndex !== index));
  if (others + next > GROUP_PORTION_CAP) {
    return { ok: false, reason: `这场拼单最多 ${GROUP_PORTION_CAP} 份` };
  }
  if (next === 0 && index >= 0) {
    lines.splice(index, 1);
  } else if (index >= 0) {
    const currentLine = lines[index]!;
    lines[index] = { ...currentLine, quantity: next, displayName: input.displayName || currentLine.displayName };
  } else {
    lines.push({
      openId: input.openId,
      displayName: input.displayName,
      productCode: input.productCode,
      quantity: next,
    });
  }
  return { ok: true, lines };
}

export function dropLines(lines: readonly VoteLine[], openId: string): VoteLine[] {
  return lines.filter((line) => line.openId !== openId);
}

export function aggregateItems(vote: Pick<GroupVote, "candidates" | "lines">): { productCode: string; quantity: number; name: string }[] {
  const totals = new Map<string, number>();
  for (const line of vote.lines) totals.set(line.productCode, (totals.get(line.productCode) ?? 0) + line.quantity);
  return [...totals.entries()]
    .filter((entry) => entry[1] > 0)
    .map(([productCode, quantity]) => ({
      productCode,
      quantity,
      name: vote.candidates.find((candidate) => candidate.productCode === productCode)?.name ?? productCode,
    }));
}

export function pickCandidates(meals: readonly MealInfo[], limit = 8): Candidate[] {
  const plain = meals.filter((meal) => !meal.discountType?.startsWith("随单购"));
  const pool = plain.length >= 6 ? plain : [...meals];
  return pool.slice(0, Math.min(Math.max(limit, 0), 8)).map((meal) => ({
    productCode: meal.code,
    name: meal.name,
    referenceFen: yuanStringToFen(meal.discountType?.startsWith("随单购") ? meal.originalPrice : meal.currentPrice),
  }));
}

export function formatSignup(vote: Pick<GroupVote, "candidates" | "lines">): string {
  const used = totalPortions(vote.lines);
  if (vote.lines.length === 0) return `还没有人勾选　共 0/${GROUP_PORTION_CAP} 份`;
  const parts = vote.lines.map((line) => {
    const name = vote.candidates.find((candidate) => candidate.productCode === line.productCode)?.name ?? line.productCode;
    return `${line.displayName} ×${line.quantity} ${name}`;
  });
  return `已报名：${parts.join("；")}　共 ${used}/${GROUP_PORTION_CAP} 份`;
}

export function parseGroupCommand(
  text: string,
): { type: "start"; scene: GroupScene; slot: string } | { type: "incomplete" } | undefined {
  const match = /^\/麦麦\s+拼单(?:\s+(.*))?$/.exec(text.trim());
  if (!match) return undefined;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { type: "incomplete" };
  const time = /(\d{1,2}):(\d{2})/.exec(rest);
  if (!time?.[1] || !time[2]) return { type: "incomplete" };
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return { type: "incomplete" };
  const slot = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { type: "start", scene: sceneFrom(rest.replace(time[0]!, "")), slot };
}

export const GROUP_HELP_TEXT = [
  "在群里 @我，发送：/麦麦 拼单 午饭 12:00",
  "先用发起人已经保存的那一家店。一场拼单只有这一家店、这一个时段，最多 10 份。",
  "大家在卡片上改自己的份数，这一步不会向麦当劳查询。",
  "只有发起人可以截止、核价和下单。付款链接只私发给发起人。",
  "本工具不收款。发起人自己付款，AA 只记账，大家线下结算。",
].join("\n");

function sceneFrom(text: string): GroupScene {
  if (/加班/.test(text)) return "加班餐";
  if (/团队|团建/.test(text)) return "团队活动";
  if (/其他/.test(text)) return "其他";
  if (/午|午饭|午餐|中饭/.test(text) || text.trim() === "") return "午餐";
  return "其他";
}
