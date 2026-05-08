#!/usr/bin/env node
import readline from "node:readline";
import { processMessage, releaseSession, type BridgeState } from "./forward.js";
import { asJsonRpcError } from "./error-messages.js";
import type { JsonRpcMessage } from "./types.js";

const state: BridgeState = {
  config: {
    host: process.env.SELECTS_MCP_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.SELECTS_MCP_PORT ?? "23100", 10),
    path: process.env.SELECTS_MCP_PATH ?? "/mcp",
  },
};

let shuttingDown = false;

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;

  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(text) as JsonRpcMessage;
  } catch {
    write(asJsonRpcError(null, -32700, "Parse error: invalid JSON"));
    return;
  }

  void handle(msg);
});

rl.on("close", () => {
  void shutdown();
});

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

async function handle(msg: JsonRpcMessage): Promise<void> {
  const responses = await processMessage(msg, state);
  for (const response of responses) {
    write(response);
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await releaseSession(state);
  process.exit(0);
}

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
