import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { processMessage, type BridgeState } from "../forward.js";
import type { JsonRpcMessage } from "../types.js";
import type { ToolResultPayload } from "../error-messages.js";

type RequestHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = undefined;
  }
});

async function startMockServer(handler: RequestHandler): Promise<number> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => handler(req, res, body));
  });
  activeServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Server did not bind");
  }
  return address.port;
}

function makeState(port: number): BridgeState {
  return { config: { host: "127.0.0.1", port, path: "/mcp" } };
}

function getResultPayload(response: JsonRpcMessage): ToolResultPayload {
  return response.result as ToolResultPayload;
}

describe("processMessage — error scenarios", () => {
  it("returns a friendly tool error when Selects is not running (ECONNREFUSED)", async () => {
    const state: BridgeState = {
      config: { host: "127.0.0.1", port: 1, path: "/mcp" },
    };
    const responses = await processMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      },
      state,
    );

    expect(responses).toHaveLength(1);
    const result = getResultPayload(responses[0]!);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Selects is not running/);
    expect(result.content[0]?.text).toMatch(/launch_app/);
  });

  it("returns a JSON-RPC error (not tool result) when forwarding non tools/call without a server", async () => {
    const state: BridgeState = {
      config: { host: "127.0.0.1", port: 1, path: "/mcp" },
    };
    const responses = await processMessage(
      { jsonrpc: "2.0", id: 7, method: "ping" },
      state,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]?.error).toBeDefined();
    expect(responses[0]?.error?.code).toBe(-32000);
  });

  it("maps HTTP 404 to an actionable update-app message for tool calls", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });

    const responses = await processMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      },
      makeState(port),
    );

    const result = getResultPayload(responses[0]!);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/does not expose an MCP endpoint/);
  });

  it("maps HTTP 500 to an internal-error message", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(500);
      res.end("kaboom");
    });

    const responses = await processMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      },
      makeState(port),
    );

    const result = getResultPayload(responses[0]!);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/internal error/i);
  });
});

describe("processMessage — happy path forwarding", () => {
  it("forwards JSON response unchanged for non tools/list calls", async () => {
    const port = await startMockServer((_req, res, body) => {
      const incoming = JSON.parse(body) as JsonRpcMessage;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: incoming.id,
          result: { ok: true },
        }),
      );
    });

    const responses = await processMessage(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      },
      makeState(port),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]?.result).toEqual({ ok: true });
  });

  it("captures the mcp-session-id header on first response and reuses it", async () => {
    let receivedSession: string | undefined;
    let calls = 0;
    const port = await startMockServer((req, res, body) => {
      calls += 1;
      receivedSession = req.headers["mcp-session-id"] as string | undefined;
      const incoming = JSON.parse(body) as JsonRpcMessage;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (calls === 1) headers["mcp-session-id"] = "session-xyz";
      res.writeHead(200, headers);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: incoming.id, result: {} }));
    });

    const state = makeState(port);
    await processMessage({ jsonrpc: "2.0", id: 1, method: "ping" }, state);
    expect(state.sessionId).toBe("session-xyz");

    await processMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, state);
    expect(receivedSession).toBe("session-xyz");
  });

  it("injects launch_app into a tools/list response", async () => {
    const port = await startMockServer((_req, res, body) => {
      const incoming = JSON.parse(body) as JsonRpcMessage;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: incoming.id,
          result: {
            tools: [
              { name: "list_projects", description: "List all projects" },
              { name: "query", description: "Query transcripts" },
            ],
          },
        }),
      );
    });

    const responses = await processMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      makeState(port),
    );

    const tools = (responses[0]?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "list_projects",
      "query",
      "launch_app",
    ]);
  });

  it("parses SSE response and forwards each event", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"jsonrpc":"2.0","id":1,"result":{"step":1}}\n\n');
      res.write('data: {"jsonrpc":"2.0","id":1,"result":{"step":2}}\n\n');
      res.end();
    });

    const responses = await processMessage(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      makeState(port),
    );

    expect(responses).toHaveLength(2);
    expect((responses[0]?.result as { step: number }).step).toBe(1);
    expect((responses[1]?.result as { step: number }).step).toBe(2);
  });
});

describe("processMessage — launch_app routing", () => {
  it("does not forward launch_app to HTTP — bridge handles it locally", async () => {
    let postHits = 0;
    const port = await startMockServer((req, res) => {
      if (req.method === "POST") postHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });

    const responses = await processMessage(
      {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "launch_app", arguments: {} },
      },
      makeState(port),
    );

    expect(postHits).toBe(0);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(99);
    const result = getResultPayload(responses[0]!);
    expect(result.content[0]?.text).toMatch(/Selects is already running|has launched/);
  });
});
