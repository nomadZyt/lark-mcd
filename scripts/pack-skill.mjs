#!/usr/bin/env node
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(root, "skills", "lark-mcd");
const outFile = join(root, "dist", "lark-mcd-skill.zip");
const allowedKeys = new Set(["name", "description", "license", "compatibility", "metadata"]);

const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
validateFrontmatter(skill);

const files = walk(skillDir)
  .map((abs) => ({
    name: relative(skillDir, abs).split("\\").join("/"),
    data: readFileSync(abs),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (!files.some((file) => file.name === "SKILL.md")) {
  throw new Error("技能包里没有 SKILL.md");
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, zipStore(files));
for (const file of files) process.stdout.write(`${file.name}\n`);
process.stdout.write(`${outFile}\n`);

function validateFrontmatter(text) {
  if (!text.startsWith("---\n")) throw new Error("SKILL.md 缺少 frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter 没有结束");
  const front = text.slice(4, end);
  if (front.includes("disable-model-invocation") || front.includes("allowed-tools")) {
    throw new Error("SKILL.md 不能写 disable-model-invocation 或 allowed-tools");
  }
  const name = /^name:\s*(\S+)\s*$/m.exec(front);
  if (!name || name[1] !== "lark-mcd") throw new Error("name 必须是 lark-mcd");
  if (!/^description:\s*\S+/m.test(front)) throw new Error("缺少 description");
  if (!/^license:\s*\S+/m.test(front)) throw new Error("缺少 license");
  const description = /^description:\s*(.+)$/m.exec(front);
  if (description && description[1].length > 1024) throw new Error("description 超过 1024 字符");
  for (const line of front.split("\n")) {
    if (!line.trim() || line.startsWith(" ") || line.startsWith("\t")) continue;
    const key = line.slice(0, line.indexOf(":"));
    if (!allowedKeys.has(key)) throw new Error(`frontmatter 字段不在通用集合里：${key}`);
  }
}

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) found.push(...walk(abs));
    else found.push(abs);
  }
  return found;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, compressed);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralDir, end]);
}
