import { request as httpRequest } from "node:http";
import { handleLaunchApp } from "./launch-app.js";
import {
  asJsonRpcResponse,
  mapHttpStatusError,
  mapTransportError,
  type ToolResultPayload,
} from "./error-messages.js";
import {
  injectLaunchAppTool,
  isLaunchAppCall,
  isToolResult,
  parseSseEvents,
  safeParseRpc,
} from "./protocol.js";
import type { BridgeConfig, JsonRpcError, JsonRpcMessage } from "./types.js";

const FORWARD_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 1000;

export interface BridgeState {
  config: BridgeConfig;
  sessionId?: string;
}

export async function processMessage(
  msg: JsonRpcMessage,
  state: BridgeState,
): Promise<JsonRpcMessage[]> {
  if (isLaunchAppCall(msg)) {
    const params = msg.params as { arguments?: Record<string, unknown> } | undefined;
    const result = await handleLaunchApp(params?.arguments, state.config);
    return [asJsonRpcResponse(msg.id, result)];
  }

  try {
    const response = await forward(msg, state);
    if (response.kind === "json") {
      if (msg.method === "tools/list") {
        injectLaunchAppTool(response.body);
      }
      return [response.body];
    }
    const out: JsonRpcMessage[] = [];
    for (const event of response.events) {
      const parsed = safeParseRpc(event);
      if (!parsed) continue;
      if (msg.method === "tools/list") {
        injectLaunchAppTool(parsed);
      }
      out.push(parsed);
    }
    return out;
  } catch (error) {
    return [mapErrorToResponse(error, msg)];
  }
}

function mapErrorToResponse(error: unknown, msg: JsonRpcMessage): JsonRpcMessage {
  const isToolCall = msg.method === "tools/call";
  const mapped: ToolResultPayload | JsonRpcError =
    error instanceof HttpStatusError
      ? mapHttpStatusError(error.status, error.bodyText, { isToolCall })
      : mapTransportError(error, { isToolCall });

  if (isToolResult(mapped)) {
    return asJsonRpcResponse(msg.id, mapped);
  }
  return {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: mapped,
  };
}

interface JsonResponse {
  kind: "json";
  body: JsonRpcMessage;
}
interface SseResponse {
  kind: "sse";
  events: string[];
}
type ForwardResponse = JsonResponse | SseResponse;

function forward(msg: JsonRpcMessage, state: BridgeState): Promise<ForwardResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(msg);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(payload).toString(),
    };
    if (state.sessionId) headers["mcp-session-id"] = state.sessionId;

    const req = httpRequest(
      {
        method: "POST",
        host: state.config.host,
        port: state.config.port,
        path: state.config.path,
        timeout: FORWARD_TIMEOUT_MS,
        headers,
      },
      (res) => {
        const incomingSessionId = res.headers["mcp-session-id"];
        if (typeof incomingSessionId === "string" && !state.sessionId) {
          state.sessionId = incomingSessionId;
        }

        const status = res.statusCode ?? 0;
        const contentType = (res.headers["content-type"] ?? "").toString();

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");

          if (status >= 400) {
            reject(new HttpStatusError(status, bodyText));
            return;
          }

          if (contentType.startsWith("text/event-stream")) {
            resolve({ kind: "sse", events: parseSseEvents(bodyText) });
            return;
          }

          const body = safeParseRpc(bodyText);
          if (!body) {
            reject(
              new Error(
                `Invalid JSON response from Selects: ${bodyText.slice(0, 200)}`,
              ),
            );
            return;
          }
          resolve({ kind: "json", body });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new TimeoutError());
    });

    req.write(payload);
    req.end();
  });
}

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

class TimeoutError extends Error {
  public readonly code = "ETIMEDOUT";
  constructor() {
    super("TIMEOUT");
    this.name = "TimeoutError";
  }
}

export function releaseSession(state: BridgeState): Promise<void> {
  if (!state.sessionId) return Promise.resolve();
  const sid = state.sessionId;
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        method: "DELETE",
        host: state.config.host,
        port: state.config.port,
        path: state.config.path,
        headers: { "mcp-session-id": sid },
        timeout: CLEANUP_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}
