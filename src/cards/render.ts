import type { FeishuCard } from "./types.js";

/** 终端里的卡片预览，只覆盖我们用到的标题、文本和按钮。 */
export function renderCardText(card: FeishuCard): string {
  const lines: string[] = [];
  const bar = "─".repeat(44);
  lines.push(`┌${bar}┐`);
  lines.push(`│ ${card.header.title.content}`);
  lines.push(`├${bar}┤`);
  for (const element of card.body.elements) {
    for (const row of renderElement(element)) lines.push(`│ ${row}`);
  }
  lines.push(`└${bar}┘`);
  return lines.join("\n");
}

function renderElement(element: Record<string, unknown>): string[] {
  if (element.tag === "markdown" && typeof element.content === "string") {
    return element.content.split("\n");
  }
  if (element.tag === "hr") return ["────────────────────────"];
  if (element.tag === "button") {
    const text = (element.text as { content?: string } | undefined)?.content ?? "按钮";
    const behavior = (element.behaviors as { type?: string }[] | undefined)?.[0];
    const suffix = behavior?.type === "open_url" ? " ↗" : "";
    return [`[ ${text}${suffix} ]`];
  }
  if (element.tag === "form" && Array.isArray(element.elements)) {
    return element.elements.flatMap((child) =>
      child && typeof child === "object" ? renderElement(child as Record<string, unknown>) : [],
    );
  }
  if (element.tag === "input") return ["[ 填写卡价 ]"];
  if (element.tag === "select_static") return ["[ 每周大约几次 ]"];
  return [];
}
