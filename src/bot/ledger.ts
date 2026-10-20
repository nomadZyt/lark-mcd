import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PersonShare } from "../core/aa.js";
import { fenToYuanNumber } from "../core/money.js";
import { displayNameFromOpenId } from "../core/group-vote.js";

/** 台账只保留报销需要的字段。不写手机号、地址、取餐码、完整订单号。 */
export interface LedgerRecord {
  datetime: string;
  storeName: string;
  orderTail: string;
  scene: string;
  headcount: number;
  participantOpenId: string;
  participantName: string;
  itemsText: string;
  shareYuan: number;
  orderTotalYuan: number;
  payStatus: string;
  invoiced: boolean;
  settled: boolean;
}

export interface LedgerWriteResult {
  destination: "bitable" | "json" | "memory";
  count: number;
}

export interface LedgerWriter {
  write(rows: readonly LedgerRecord[]): Promise<LedgerWriteResult>;
  updatePayStatus(orderTail: string, payStatus: string): Promise<void>;
}

export const LEDGER_FIELDS = {
  datetime: "日期时间",
  store: "门店",
  orderTail: "订单号（后 4 位）",
  scene: "场景 / 事由",
  headcount: "人数",
  person: "参与人",
  items: "餐品明细",
  share: "应摊金额（元）",
  total: "订单实付（元）",
  pay: "支付状态",
  invoiced: "是否已开票",
  settled: "已结算",
} as const;

const ALLOWED_KEYS = [
  "datetime",
  "storeName",
  "orderTail",
  "scene",
  "headcount",
  "participantOpenId",
  "participantName",
  "itemsText",
  "shareYuan",
  "orderTotalYuan",
  "payStatus",
  "invoiced",
  "settled",
] as const;

export function defaultLedgerPath(): string {
  return join(homedir(), ".lark-mcd", "ledger.json");
}

export function clipOrderTail(value: string): string {
  const clean = value.trim().replace(/^…/, "");
  if (clean === "演练") return clean;
  if (clean.length <= 4) return clean;
  return clean.slice(-4);
}

export function scrubLedgerText(text: string): string {
  return text
    .replace(/1[3-9]\d{9}/g, "")
    .replace(/取餐码[:：]?\s*[A-Za-z0-9-]*/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[A-Za-z]{2,}\d{8,}/g, "")
    .trim();
}

export function sanitizeLedgerRecord(input: LedgerRecord): LedgerRecord {
  const record: LedgerRecord = {
    datetime: scrubLedgerText(input.datetime),
    storeName: scrubLedgerText(input.storeName),
    orderTail: clipOrderTail(input.orderTail),
    scene: scrubLedgerText(input.scene),
    headcount: input.headcount,
    participantOpenId: input.participantOpenId,
    participantName: scrubLedgerText(input.participantName),
    itemsText: scrubLedgerText(input.itemsText),
    shareYuan: input.shareYuan,
    orderTotalYuan: input.orderTotalYuan,
    payStatus: scrubLedgerText(input.payStatus),
    invoiced: false,
    settled: false,
  };
  return record;
}

/** 从松散对象里只留下白名单字段。手机号、地址、取餐码、完整订单号会被丢掉。 */
export function ledgerRecordFromUnknown(input: Record<string, unknown>): LedgerRecord {
  const text = (key: string): string => (typeof input[key] === "string" ? input[key] : "");
  const orderSource = text("orderTail") || text("orderId") || text("order_id");
  return sanitizeLedgerRecord({
    datetime: text("datetime"),
    storeName: text("storeName"),
    orderTail: orderSource,
    scene: text("scene"),
    headcount: typeof input.headcount === "number" ? input.headcount : 0,
    participantOpenId: text("participantOpenId"),
    participantName: text("participantName"),
    itemsText: text("itemsText"),
    shareYuan: typeof input.shareYuan === "number" ? input.shareYuan : 0,
    orderTotalYuan: typeof input.orderTotalYuan === "number" ? input.orderTotalYuan : 0,
    payStatus: text("payStatus"),
    invoiced: false,
    settled: false,
  });
}

export function ledgerBody(records: readonly LedgerRecord[]): string {
  const clean = records.map((record) => {
    const safe = sanitizeLedgerRecord(record);
    const body: Record<string, string | number | boolean> = {};
    for (const key of ALLOWED_KEYS) body[key] = safe[key];
    return body;
  });
  return JSON.stringify(clean);
}

export function buildLedgerRows(input: {
  datetime: string;
  storeName: string;
  orderId?: string;
  dryRun: boolean;
  scene: string;
  shares: readonly PersonShare[];
  names: ReadonlyMap<string, string>;
  orderFen: number;
  payStatus: string;
}): LedgerRecord[] {
  const paying = input.shares.filter((share) => share.lines.some((line) => line.quantity > 0) || share.shareFen !== 0);
  const headcount = paying.length;
  const orderTail = input.dryRun || !input.orderId ? "演练" : clipOrderTail(input.orderId);
  return paying.map((share) =>
    sanitizeLedgerRecord({
      datetime: input.datetime,
      storeName: input.storeName,
      orderTail,
      scene: input.scene,
      headcount,
      participantOpenId: share.openId,
      participantName: input.names.get(share.openId) ?? displayNameFromOpenId(share.openId),
      itemsText: share.lines
        .filter((line) => line.quantity > 0)
        .map((line) => `${line.productName} × ${line.quantity}`)
        .join("；"),
      shareYuan: Number((fenToYuanNumber(share.shareFen)).toFixed(2)),
      orderTotalYuan: Number((fenToYuanNumber(input.orderFen)).toFixed(2)),
      payStatus: input.payStatus,
      invoiced: false,
      settled: false,
    }),
  );
}

export function bitableFields(record: LedgerRecord): Record<string, string | number | boolean | { id: string }[]> {
  const clean = sanitizeLedgerRecord(record);
  const when = Date.parse(clean.datetime);
  return {
    [LEDGER_FIELDS.datetime]: Number.isNaN(when) ? Date.now() : when,
    [LEDGER_FIELDS.store]: clean.storeName,
    [LEDGER_FIELDS.orderTail]: clean.orderTail,
    [LEDGER_FIELDS.scene]: clean.scene,
    [LEDGER_FIELDS.headcount]: clean.headcount,
    [LEDGER_FIELDS.person]: [{ id: clean.participantOpenId }],
    [LEDGER_FIELDS.items]: clean.itemsText,
    [LEDGER_FIELDS.share]: clean.shareYuan,
    [LEDGER_FIELDS.total]: clean.orderTotalYuan,
    [LEDGER_FIELDS.pay]: clean.payStatus,
    [LEDGER_FIELDS.invoiced]: false,
    [LEDGER_FIELDS.settled]: false,
  };
}

interface StoredLedger {
  records: LedgerRecord[];
}

export class MemoryLedger implements LedgerWriter {
  readonly rows: LedgerRecord[] = [];

  async write(rows: readonly LedgerRecord[]): Promise<LedgerWriteResult> {
    const clean = rows.map((row) => sanitizeLedgerRecord(row));
    this.rows.push(...clean);
    return { destination: "memory", count: clean.length };
  }

  async updatePayStatus(orderTail: string, payStatus: string): Promise<void> {
    const tail = clipOrderTail(orderTail);
    const status = scrubLedgerText(payStatus);
    for (const row of this.rows) {
      if (row.orderTail === tail) row.payStatus = status;
    }
  }
}

export class JsonLedger implements LedgerWriter {
  constructor(private readonly file: string) {}

  async write(rows: readonly LedgerRecord[]): Promise<LedgerWriteResult> {
    const current = this.read();
    current.records.push(...rows.map((row) => sanitizeLedgerRecord(row)));
    this.save(current);
    return { destination: "json", count: rows.length };
  }

  async updatePayStatus(orderTail: string, payStatus: string): Promise<void> {
    const tail = clipOrderTail(orderTail);
    const status = scrubLedgerText(payStatus);
    const current = this.read();
    for (const row of current.records) {
      if (row.orderTail === tail) row.payStatus = status;
    }
    this.save(current);
  }

  read(): StoredLedger {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoredLedger;
      const records = Array.isArray(parsed.records) ? parsed.records.map((row) => sanitizeLedgerRecord(row)) : [];
      return { records };
    } catch {
      return { records: [] };
    }
  }

  private save(current: StoredLedger): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const records = JSON.parse(ledgerBody(current.records)) as LedgerRecord[];
    writeFileSync(this.file, `${JSON.stringify({ records }, null, 2)}\n`, { mode: 0o600 });
  }
}

interface IndexRow {
  orderTail: string;
  openId: string;
  recordId: string;
}

export class FileRecordIndex {
  constructor(private readonly file: string) {}

  idsFor(orderTail: string): string[] {
    return this.read()
      .filter((row) => row.orderTail === orderTail)
      .map((row) => row.recordId);
  }

  remember(orderTail: string, openId: string, recordId: string): void {
    if (!recordId) return;
    const rows = this.read().filter((row) => !(row.orderTail === orderTail && row.openId === openId));
    rows.push({ orderTail, openId, recordId });
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ records: rows })}\n`, { mode: 0o600 });
  }

  private read(): IndexRow[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { records?: IndexRow[] };
      return Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }
}

export interface BitableClient {
  batchCreate(
    appToken: string,
    tableId: string,
    records: { fields: Record<string, string | number | boolean | { id: string }[]> }[],
  ): Promise<{ recordId: string }[]>;
  batchUpdate(
    appToken: string,
    tableId: string,
    records: { recordId: string; fields: Record<string, string | number | boolean | { id: string }[]> }[],
  ): Promise<void>;
}

export class BitableLedger implements LedgerWriter {
  constructor(
    private readonly client: BitableClient,
    private readonly appToken: string,
    private readonly tableId: string,
    private readonly fallback: JsonLedger,
    private readonly index: FileRecordIndex,
  ) {}

  async write(rows: readonly LedgerRecord[]): Promise<LedgerWriteResult> {
    const clean = rows.map((row) => sanitizeLedgerRecord(row));
    try {
      const created = await this.client.batchCreate(
        this.appToken,
        this.tableId,
        clean.map((row) => ({ fields: bitableFields(row) })),
      );
      created.forEach((item, index) => {
        const row = clean[index];
        if (row) this.index.remember(row.orderTail, row.participantOpenId, item.recordId);
      });
      return { destination: "bitable", count: clean.length };
    } catch {
      await this.fallback.write(clean);
      return { destination: "json", count: clean.length };
    }
  }

  async updatePayStatus(orderTail: string, payStatus: string): Promise<void> {
    const tail = clipOrderTail(orderTail);
    const status = scrubLedgerText(payStatus);
    const ids = this.index.idsFor(tail);
    if (ids.length === 0) {
      await this.fallback.updatePayStatus(tail, status);
      return;
    }
    try {
      await this.client.batchUpdate(
        this.appToken,
        this.tableId,
        ids.map((recordId) => ({ recordId, fields: { [LEDGER_FIELDS.pay]: status } })),
      );
    } catch {
      await this.fallback.updatePayStatus(tail, status);
    }
  }
}

export function ledgerIndexPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), "ledger-index.json");
}

export function createLedger(options: {
  appToken?: string;
  tableId?: string;
  ledgerPath: string;
  bitable?: BitableClient;
}): LedgerWriter {
  const json = new JsonLedger(options.ledgerPath);
  if (options.appToken && options.tableId && options.bitable) {
    return new BitableLedger(options.bitable, options.appToken, options.tableId, json, new FileRecordIndex(ledgerIndexPath(options.ledgerPath)));
  }
  return json;
}
