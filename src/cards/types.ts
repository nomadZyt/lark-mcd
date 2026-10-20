export interface CardLine {
  name: string;
  quantity: number;
  subtotalFen: number;
}

export interface TakeWayOption {
  code: string;
  title: string;
}

export type CardModel =
  | {
      kind: "priced";
      storeName: string;
      lines: CardLine[];
      totalFen: number;
      discountFen: number;
      tablewareFen: number;
      takeWays: TakeWayOption[];
      selectedTakeWay: string;
      needTableware: boolean;
      sessionId: string;
      comboDefault: boolean;
      eligibleCount: number;
      paybackLines: string[] | null;
      staleNote?: string;
    }
  | {
      kind: "dry-run";
      storeName: string;
      lines: CardLine[];
      totalFen: number;
      takeWayTitle: string;
      sessionId: string;
    }
  | {
      kind: "pay";
      sessionId: string;
      orderTail: string;
      totalFen: number;
      payH5Url: string;
      note?: string;
    }
  | {
      kind: "paid";
      sessionId: string;
      orderTail: string;
      totalFen: number;
      pickupCode: string;
      lockerCode?: string;
      orderStatus: string;
    }
  | {
      kind: "confirm-cancel";
      sessionId: string;
      orderTail: string;
    }
  | {
      kind: "stores";
      stores: { storeCode: string; storeName: string }[];
    }
  | {
      kind: "note";
      title: string;
      lines: string[];
      sessionId?: string;
    }
  | {
      kind: "agent-propose";
      sessionId: string;
      storeName: string;
      lines: CardLine[];
      totalFen: number;
      takeWayTitle: string;
      dryRun: boolean;
    }
  | {
      kind: "group-vote";
      sessionId: string;
      storeName: string;
      scene: string;
      slot: string;
      signup: string;
      cap: number;
      candidates: { productCode: string; name: string; referenceFen: number; total: number }[];
    }
  | {
      kind: "group-priced";
      sessionId: string;
      storeName: string;
      scene: string;
      scenes: readonly string[];
      slot: string;
      totalFen: number;
      discountFen: number;
      tablewareFen: number;
      shares: { name: string; shareFen: number }[];
      takeWays: TakeWayOption[];
      selectedTakeWay: string;
    }
  | {
      kind: "group-status";
      sessionId: string;
      title: string;
      lines: string[];
      refresh: boolean;
    };

export interface FeishuCard {
  schema: "2.0";
  config: { update_multi: boolean };
  header: {
    title: { tag: "plain_text"; content: string };
    template: "orange" | "green" | "blue" | "grey" | "red" | "wathet";
  };
  body: { elements: Record<string, unknown>[] };
}
