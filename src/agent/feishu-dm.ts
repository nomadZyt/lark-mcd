import { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuCard } from "../cards/types.js";

export interface ProposalNotifier {
  send(openId: string, card: FeishuCard): Promise<void>;
}

/** 把确认卡片发到 Token 主人的飞书私聊。不下单。 */
export class LarkDmNotifier implements ProposalNotifier {
  private readonly client: Client;

  constructor(appId: string, appSecret: string) {
    this.client = new Client({ appId, appSecret });
  }

  async send(openId: string, card: FeishuCard): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }
}
