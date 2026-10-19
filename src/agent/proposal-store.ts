import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AgentError } from "./errors.js";
import { withFileLock } from "./lock.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const lineSchema = z.object({
  productCode: z.string(),
  productName: z.string(),
  quantity: z.number().int().positive(),
  subtotalFen: z.number().int(),
});

const quoteSchema = z.object({
  id: z.string(),
  storeCode: z.string(),
  storeName: z.string(),
  items: z.array(
    z.object({
      productCode: z.string(),
      quantity: z.number().int().positive(),
      name: z.string().optional(),
    }),
  ),
  priceFen: z.number().int(),
  discountFen: z.number().int(),
  tablewareFen: z.number().int(),
  lines: z.array(lineSchema),
  takeWays: z.array(z.object({ code: z.string(), title: z.string() })),
  takeWayCode: z.string(),
  needTableware: z.boolean(),
  quotedAt: z.number().int(),
});

export type AgentQuote = z.infer<typeof quoteSchema>;
export type ProposalStatus = "pending" | "confirmed" | "dismissed";

const proposalSchema = z.object({
  id: z.string(),
  quoteId: z.string(),
  status: z.enum(["pending", "confirmed", "dismissed"]),
  createdAt: z.number().int(),
  quote: quoteSchema,
});

export type AgentProposal = z.infer<typeof proposalSchema>;

const boardSchema = z.object({
  quotes: z.array(quoteSchema),
  proposals: z.array(proposalSchema),
});

type Board = z.infer<typeof boardSchema>;

export interface ProposalStore {
  saveQuote(quote: AgentQuote, now?: number): void;
  getQuote(id: string): AgentQuote | undefined;
  saveProposal(proposal: AgentProposal, now?: number): void;
  getProposal(id: string): AgentProposal | undefined;
  updateStatus(id: string, status: ProposalStatus, now?: number): void;
  listProposals(): AgentProposal[];
}

function emptyBoard(): Board {
  return { quotes: [], proposals: [] };
}

function prune(board: Board, now: number): Board {
  return {
    quotes: board.quotes.filter((quote) => now - quote.quotedAt < DAY_MS),
    proposals: board.proposals.filter((proposal) => now - proposal.createdAt < DAY_MS),
  };
}

export class MemoryProposalStore implements ProposalStore {
  private board: Board = emptyBoard();

  saveQuote(quote: AgentQuote, now = Date.now()): void {
    this.board = prune(this.board, now);
    this.board.quotes = this.board.quotes.filter((item) => item.id !== quote.id);
    this.board.quotes.push(structuredClone(quote));
  }

  getQuote(id: string): AgentQuote | undefined {
    const found = this.board.quotes.find((quote) => quote.id === id);
    return found ? structuredClone(found) : undefined;
  }

  saveProposal(proposal: AgentProposal, now = Date.now()): void {
    this.board = prune(this.board, now);
    this.board.proposals = this.board.proposals.filter((item) => item.id !== proposal.id);
    this.board.proposals.push(structuredClone(proposal));
  }

  getProposal(id: string): AgentProposal | undefined {
    const found = this.board.proposals.find((proposal) => proposal.id === id);
    return found ? structuredClone(found) : undefined;
  }

  updateStatus(id: string, status: ProposalStatus): void {
    const found = this.board.proposals.find((proposal) => proposal.id === id);
    if (found) found.status = status;
  }

  listProposals(): AgentProposal[] {
    return structuredClone(this.board.proposals);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export class FileProposalStore implements ProposalStore {
  private readonly file: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    this.file = join(dir, "agent-board.json");
    this.lockPath = join(dir, "agent-board.lock");
  }

  saveQuote(quote: AgentQuote, now = Date.now()): void {
    withFileLock(this.lockPath, () => {
      const board = prune(this.read(), now);
      board.quotes = board.quotes.filter((item) => item.id !== quote.id);
      board.quotes.push(quote);
      writeJson(this.file, board);
    });
  }

  getQuote(id: string): AgentQuote | undefined {
    return this.read().quotes.find((quote) => quote.id === id);
  }

  saveProposal(proposal: AgentProposal, now = Date.now()): void {
    withFileLock(this.lockPath, () => {
      const board = prune(this.read(), now);
      board.proposals = board.proposals.filter((item) => item.id !== proposal.id);
      board.proposals.push(proposal);
      writeJson(this.file, board);
    });
  }

  getProposal(id: string): AgentProposal | undefined {
    return this.read().proposals.find((proposal) => proposal.id === id);
  }

  updateStatus(id: string, status: ProposalStatus, now = Date.now()): void {
    withFileLock(this.lockPath, () => {
      const board = prune(this.read(), now);
      const found = board.proposals.find((proposal) => proposal.id === id);
      if (!found) return;
      found.status = status;
      writeJson(this.file, board);
    });
  }

  listProposals(): AgentProposal[] {
    return this.read().proposals;
  }

  private read(): Board {
    try {
      const parsed = boardSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) {
        throw new AgentError("NOT_CONFIGURED", "本机报价状态无法读取");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return emptyBoard();
      throw new AgentError("NOT_CONFIGURED", "本机报价状态无法读取");
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
