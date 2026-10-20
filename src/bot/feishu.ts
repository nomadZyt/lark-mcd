import { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuCard } from "../cards/types.js";
import type { Outbound } from "./dispatch.js";

export class LarkOutbound implements Outbound {
  private readonly client: Client;

  constructor(appId: string, appSecret: string) {
    this.client = new Client({ appId, appSecret });
  }

  async sendCard(chatId: string, card: FeishuCard): Promise<string | void> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    return response.data?.message_id;
  }

  async sendDirectCard(openId: string, card: FeishuCard): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  async patchCard(messageId: string, card: FeishuCard): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }
}
