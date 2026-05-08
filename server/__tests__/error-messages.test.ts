import { describe, expect, it } from "vitest";
import {
  appNotInstalledError,
  asJsonRpcError,
  asJsonRpcResponse,
  asToolError,
  asToolSuccess,
  launchPlatformUnsupportedError,
  launchSpawnError,
  launchTimeoutError,
  mapHttpStatusError,
  mapTransportError,
  type ToolResultPayload,
} from "../error-messages.js";

function makeNodeError(code: string, message = "boom"): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

describe("asToolError / asToolSuccess", () => {
  it("asToolError marks isError=true", () => {
    expect(asToolError("nope")).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
  });

  it("asToolSuccess does not include isError", () => {
    const result = asToolSuccess("ok");
    expect(result.content[0]?.text).toBe("ok");
    expect(result.isError).toBeUndefined();
  });
});

describe("asJsonRpcResponse / asJsonRpcError", () => {
  it("wraps a result", () => {
    expect(asJsonRpcResponse(7, { hello: "world" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { hello: "world" },
    });
  });

  it("normalizes undefined id to null", () => {
    expect(asJsonRpcResponse(undefined, {})).toEqual({
      jsonrpc: "2.0",
      id: null,
      result: {},
    });
  });

  it("wraps an error", () => {
    expect(asJsonRpcError(1, -32700, "Parse error")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32700, message: "Parse error" },
    });
  });
});

describe("mapTransportError — tool-call form", () => {
  const opts = { isToolCall: true };

  it("maps ECONNREFUSED to actionable launch_app hint", () => {
    const result = mapTransportError(makeNodeError("ECONNREFUSED"), opts) as ToolResultPayload;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Selects is not running/);
    expect(result.content[0]?.text).toMatch(/launch_app/);
  });

  it("maps ECONNRESET to port collision message", () => {
    const result = mapTransportError(makeNodeError("ECONNRESET"), opts) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/port 23100/);
  });

  it("maps ETIMEDOUT to frozen-app message", () => {
    const result = mapTransportError(makeNodeError("ETIMEDOUT"), opts) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/not responding/);
  });

  it("maps a synthetic TIMEOUT message", () => {
    const result = mapTransportError(new Error("TIMEOUT"), opts) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/not responding/);
  });

  it("uses generic fallback for unknown errors", () => {
    const result = mapTransportError(new Error("weird"), opts) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/bridge error/);
  });

  it("never produces a generic 'Internal Server Error' string", () => {
    const result = mapTransportError(makeNodeError("ECONNREFUSED"), opts) as ToolResultPayload;
    expect(result.content[0]?.text).not.toMatch(/Internal Server Error/);
  });
});

describe("mapTransportError — non tool-call form", () => {
  it("returns a JsonRpcError for protocol-level forwarding", () => {
    const result = mapTransportError(makeNodeError("ECONNREFUSED"), { isToolCall: false });
    expect("code" in result).toBe(true);
    expect((result as { code: number }).code).toBe(-32000);
  });
});

describe("mapHttpStatusError", () => {
  it("404 explains MCP endpoint missing and update path", () => {
    const result = mapHttpStatusError(404, "not found", { isToolCall: true }) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/does not expose an MCP endpoint/);
  });

  it("404 includes minAppVersion hint when provided", () => {
    const result = mapHttpStatusError(404, "", {
      isToolCall: true,
      minAppVersion: "2.45.0",
    }) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/2\.45\.0/);
  });

  it("5xx is mapped to internal-error message with truncated body", () => {
    const result = mapHttpStatusError(500, "x".repeat(500), { isToolCall: true }) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/internal error/i);
    expect(result.content[0]?.text).toMatch(/…/);
  });

  it("400 surfaces rejection details", () => {
    const result = mapHttpStatusError(400, "bad request", { isToolCall: true }) as ToolResultPayload;
    expect(result.content[0]?.text).toMatch(/HTTP 400/);
  });
});

describe("launch error helpers", () => {
  it("appNotInstalledError points to download URL", () => {
    expect(appNotInstalledError().content[0]?.text).toMatch(/cutback\.video/);
  });

  it("launchTimeoutError includes the seconds the user waited", () => {
    expect(launchTimeoutError(20).content[0]?.text).toMatch(/within 20 seconds/);
  });

  it("launchSpawnError surfaces the spawn message", () => {
    expect(launchSpawnError("permission denied").content[0]?.text).toMatch(/permission denied/);
  });

  it("launchPlatformUnsupportedError includes the platform name", () => {
    expect(launchPlatformUnsupportedError("linux").content[0]?.text).toMatch(/linux/);
  });
});
