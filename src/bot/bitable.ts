import { Client } from "@larksuiteoapi/node-sdk";
import { redact } from "../core/parse.js";
import type { BitableClient } from "./ledger.js";

type FieldValue = string | number | boolean | { id: string }[];

/**
 * 只封装多维表格的新增和更新。调用身份是应用自己的 tenant token。
 * 应用必须是这张表的协作者，否则飞书会返回 403。
 */
export function createLarkBitable(appId: string, appSecret: string): BitableClient {
  const client = new Client({ appId, appSecret });
  return {
    async batchCreate(appToken, tableId, records) {
      const response = await client.bitable.v1.appTableRecord.batchCreate({
        params: { user_id_type: "open_id" },
        path: { app_token: appToken, table_id: tableId },
        data: { records: records.map((record) => ({ fields: record.fields })) },
      });
      if (response.code && response.code !== 0) {
        throw new Error(redact(response.msg || "多维表格写入失败"));
      }
      return (response.data?.records ?? []).map((record) => ({ recordId: record.record_id ?? "" }));
    },
    async batchUpdate(appToken, tableId, records) {
      const response = await client.bitable.v1.appTableRecord.batchUpdate({
        path: { app_token: appToken, table_id: tableId },
        data: {
          records: records.map((record) => ({
            record_id: record.recordId,
            fields: record.fields as Record<string, FieldValue>,
          })),
        },
      });
      if (response.code && response.code !== 0) {
        throw new Error(redact(response.msg || "多维表格更新失败"));
      }
    },
  };
}
