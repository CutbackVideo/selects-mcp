import { describe, expect, it } from "vitest";
import {
  LAUNCH_APP_TOOL,
  injectLaunchAppTool,
  isLaunchAppCall,
  isToolResult,
  parseSseEvents,
  safeParseRpc,
} from "../protocol.js";
import type { JsonRpcMessage } from "../types.js";

describe("LAUNCH_APP_TOOL", () => {
  it("is annotated as destructive and openWorld", () => {
    expect(LAUNCH_APP_TOOL.annotations.destructiveHint).toBe(true);
    expect(LAUNCH_APP_TOOL.annotations.openWorldHint).toBe(true);
    expect(LAUNCH_APP_TOOL.annotations.title).toBe("Launch Selects");
  });

  it("has a name under 64 characters", () => {
    expect(LAUNCH_APP_TOOL.name.length).toBeLessThanOrEqual(64);
  });

  it("uses English only in user-facing text", () => {
    expect(LAUNCH_APP_TOOL.description).toMatch(/^[\x00-\x7F]+$/);
    expect(LAUNCH_APP_TOOL.annotations.title).toMatch(/^[\x00-\x7F]+$/);
  });
});

describe("isLaunchAppCall", () => {
  it("returns true only for tools/call with name=launch_app", () => {
    expect(
      isLaunchAppCall({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "launch_app" },
      }),
    ).toBe(true);
  });

  it("returns false for tools/call with a different tool name", () => {
    expect(
      isLaunchAppCall({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_projects" },
      }),
    ).toBe(false);
  });

  it("returns false for non tools/call methods", () => {
    expect(
      isLaunchAppCall({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    ).toBe(false);
  });

  it("returns false when params is missing", () => {
    expect(
      isLaunchAppCall({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
      }),
    ).toBe(false);
  });
});

describe("injectLaunchAppTool", () => {
  it("appends launch_app to a tools/list result", () => {
    const body: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "list_projects", description: "..." }],
      },
    };
    injectLaunchAppTool(body);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["list_projects", "launch_app"]);
  });

  it("does nothing if result.tools is missing", () => {
    const body: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { something: "else" },
    };
    injectLaunchAppTool(body);
    expect(body.result).toEqual({ something: "else" });
  });

  it("does nothing if result is missing", () => {
    const body: JsonRpcMessage = { jsonrpc: "2.0", id: 1 };
    expect(() => injectLaunchAppTool(body)).not.toThrow();
    expect(body.result).toBeUndefined();
  });
});

describe("parseSseEvents", () => {
  it("extracts a single data event", () => {
    const text = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseSseEvents(text)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  it("extracts multiple events separated by blank lines", () => {
    const text =
      'data: {"id":1}\n\ndata: {"id":2}\n\n';
    expect(parseSseEvents(text)).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("joins multi-line data fields with newlines", () => {
    const text = 'data: line1\ndata: line2\n\n';
    expect(parseSseEvents(text)).toEqual(["line1\nline2"]);
  });

  it("ignores non-data lines (event:, id:, retry:, comments)", () => {
    const text = 'event: message\nid: 42\ndata: {"hello":"world"}\n\n';
    expect(parseSseEvents(text)).toEqual(['{"hello":"world"}']);
  });

  it("handles trailing data without a final blank line", () => {
    const text = 'data: {"final":true}';
    expect(parseSseEvents(text)).toEqual(['{"final":true}']);
  });
});

describe("safeParseRpc", () => {
  it("parses valid JSON-RPC", () => {
    const parsed = safeParseRpc('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(parsed?.jsonrpc).toBe("2.0");
    expect(parsed?.id).toBe(1);
  });

  it("returns undefined for invalid JSON", () => {
    expect(safeParseRpc("not json")).toBeUndefined();
  });

  it("returns undefined for JSON without jsonrpc field", () => {
    expect(safeParseRpc('{"foo":"bar"}')).toBeUndefined();
  });
});

describe("isToolResult", () => {
  it("returns true for objects with content array", () => {
    expect(
      isToolResult({ content: [{ type: "text", text: "hi" }], isError: false }),
    ).toBe(true);
  });

  it("returns false for JsonRpcError shape", () => {
    expect(isToolResult({ code: -32000, message: "fail" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isToolResult(null)).toBe(false);
  });
});
