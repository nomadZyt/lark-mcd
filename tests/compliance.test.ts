import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures } from "../src/core/mock-mcp.js";

const DECLARATION_SHA256 = "cd28101bcb29cc8fb24b372fe91ce6b42c4a1487a54e01f7ade0c8c6a84241b7";

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("合规", () => {
  it("源码里没有定时器去调 MCP", () => {
    const files = walk("src");
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/setInterval|setTimeout|node-cron/);
    }
  });

  it("领券和抽奖只出现在拒绝名单里", () => {
    const hits = walk("src").filter((file) => readFileSync(file, "utf8").includes("auto-bind-coupons"));
    expect(hits.map((file) => file.split("/").pop())).toEqual(["types.ts"]);
  });

  it("麦当劳地址只作为真实模式的默认值出现", () => {
    const hits = walk("src").filter((file) => readFileSync(file, "utf8").includes("mcp.mcd.cn"));
    expect(hits.map((file) => file.split("/").pop()).sort()).toEqual(["config.ts"]);
  });

  it(".gitignore 盖住 .env", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toContain("*.env");
  });

  it("参赛声明和官方文件一致", () => {
    const bytes = readFileSync("CONTEST_DECLARATION.md");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DECLARATION_SHA256);
  });

  it("演示菜单不超过 10 个商品，门店编号是假的", () => {
    const fixtures = loadFixtures();
    expect(fixtures.meals.length).toBeLessThanOrEqual(10);
    expect(fixtures.meals.length).toBeGreaterThanOrEqual(8);
    for (const store of fixtures.stores) {
      expect(store.storeCode.startsWith("DEMO-")).toBe(true);
      expect(JSON.stringify(store)).not.toContain("address");
    }
    expect(fixtures.notice).toContain("价格不代表实时价格");
  });
});
