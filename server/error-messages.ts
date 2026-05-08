import type { JsonRpcError, JsonRpcMessage } from "./types.js";

const DOWNLOAD_URL = "https://cutback.video/selects/install";

export interface ToolResultPayload {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function asToolError(text: string): ToolResultPayload {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

export function asToolSuccess(text: string): ToolResultPayload {
  return {
    content: [{ type: "text", text }],
  };
}

export function asJsonRpcResponse(
  id: JsonRpcMessage["id"],
  result: unknown,
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

export function asJsonRpcError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): JsonRpcMessage {
  const error: JsonRpcError = { code, message };
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error,
  };
}

interface NodeError extends Error {
  code?: string;
}

function isNodeError(value: unknown): value is NodeError {
  return value instanceof Error;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isNodeError(error)) return undefined;
  return error.code;
}

export interface MapErrorOptions {
  isToolCall: boolean;
  minAppVersion?: string;
}

export function mapTransportError(
  error: unknown,
  options: MapErrorOptions,
): ToolResultPayload | JsonRpcError {
  const code = getErrorCode(error);
  const message = isNodeError(error) ? error.message : String(error);

  let text: string;

  if (code === "ECONNREFUSED") {
    text =
      "Selects is not running. Use the `launch_app` tool to start it, or open the Selects app manually. " +
      `Download: ${DOWNLOAD_URL}`;
  } else if (code === "ECONNRESET" || code === "EADDRINUSE") {
    text =
      "Cannot connect to Selects MCP on port 23100. Another Selects instance may be running, or the app is shutting down.";
  } else if (code === "ETIMEDOUT" || message === "TIMEOUT") {
    text =
      "Selects is not responding. The app may be frozen — please restart it.";
  } else if (code === "ENOTFOUND" || code === "EHOSTUNREACH") {
    text =
      "Cannot reach the Selects local MCP endpoint. Check that the Selects app is running on this machine.";
  } else {
    text = `Selects bridge error: ${message}. If this persists, please restart the Selects app.`;
  }

  return options.isToolCall ? asToolError(text) : { code: -32000, message: text };
}

export function mapHttpStatusError(
  status: number,
  responseBody: string,
  options: MapErrorOptions,
): ToolResultPayload | JsonRpcError {
  let text: string;

  if (status === 404) {
    const versionHint = options.minAppVersion
      ? ` (required: >=${options.minAppVersion})`
      : "";
    text = `Selects is running but does not expose an MCP endpoint. Please update Selects to the latest version${versionHint}.`;
  } else if (status >= 500) {
    text = `Selects internal error: HTTP ${status}. If this persists, please restart the Selects app. Details: ${truncate(responseBody, 300)}`;
  } else if (status === 400) {
    text = `Selects rejected the request: HTTP 400. Details: ${truncate(responseBody, 300)}`;
  } else {
    text = `Selects returned unexpected HTTP ${status}. Details: ${truncate(responseBody, 300)}`;
  }

  return options.isToolCall ? asToolError(text) : { code: -32000, message: text };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…";
}

export function appNotInstalledError(): ToolResultPayload {
  return asToolError(
    `Could not find Selects. Make sure the Selects desktop app is installed. Download: ${DOWNLOAD_URL}`,
  );
}

export function launchTimeoutError(seconds: number): ToolResultPayload {
  return asToolError(
    `Selects did not become ready within ${seconds} seconds. Please launch the app manually. Download: ${DOWNLOAD_URL}`,
  );
}

export function launchSpawnError(message: string): ToolResultPayload {
  return asToolError(
    `Failed to launch Selects: ${message}. Please launch the app manually. Download: ${DOWNLOAD_URL}`,
  );
}

export function launchPlatformUnsupportedError(platform: string): ToolResultPayload {
  return asToolError(
    `Automatic launch is not supported on this platform (${platform}). Please launch the Selects app manually.`,
  );
}
