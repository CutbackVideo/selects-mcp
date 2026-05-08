import type { JsonRpcMessage } from "./types.js";
import type { ToolResultPayload } from "./error-messages.js";

export const LAUNCH_APP_TOOL = {
  name: "launch_app",
  description:
    "Launches the Selects desktop application if it is not already running. Use this when other tools fail with a connection error indicating Selects is not running.",
  inputSchema: {
    type: "object",
    properties: {
      wait_for_ready_seconds: {
        type: "number",
        description:
          "Maximum seconds to wait for Selects to become ready after launching. Default 15, max 60.",
        minimum: 1,
        maximum: 60,
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "Launch Selects",
    destructiveHint: true,
    openWorldHint: true,
  },
} as const;

export function isLaunchAppCall(msg: JsonRpcMessage): boolean {
  if (msg.method !== "tools/call") return false;
  const params = msg.params as { name?: string } | undefined;
  return params?.name === "launch_app";
}

export function injectLaunchAppTool(body: JsonRpcMessage): void {
  const result = body.result;
  if (!result || typeof result !== "object") return;
  const resultObj = result as { tools?: unknown };
  if (!Array.isArray(resultObj.tools)) return;
  resultObj.tools = [...resultObj.tools, LAUNCH_APP_TOOL];
}

export function isToolResult(value: unknown): value is ToolResultPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray((value as { content: unknown }).content)
  );
}

export function parseSseEvents(text: string): string[] {
  const events: string[] = [];
  let dataBuffer = "";
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      if (dataBuffer) {
        events.push(dataBuffer);
        dataBuffer = "";
      }
      continue;
    }
    if (rawLine.startsWith("data:")) {
      const value = rawLine.slice(5).replace(/^ /, "");
      dataBuffer += dataBuffer ? "\n" + value : value;
    }
  }
  if (dataBuffer) events.push(dataBuffer);
  return events;
}

export function safeParseRpc(text: string): JsonRpcMessage | undefined {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "jsonrpc" in parsed) {
      return parsed as JsonRpcMessage;
    }
  } catch {
    // ignore
  }
  return undefined;
}
