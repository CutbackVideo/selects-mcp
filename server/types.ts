export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> | undefined;
  result?: unknown;
  error?: JsonRpcError;
}

export interface BridgeConfig {
  host: string;
  port: number;
  path: string;
}
