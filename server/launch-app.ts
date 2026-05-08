import { spawn, execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  appNotInstalledError,
  asToolSuccess,
  launchPlatformUnsupportedError,
  launchSpawnError,
  launchTimeoutError,
  type ToolResultPayload,
} from "./error-messages.js";
import type { BridgeConfig } from "./types.js";

const POLL_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 1000;
const DEFAULT_WAIT_SECONDS = 15;
const MAX_WAIT_SECONDS = 60;

const APP_NAME = "Selects";
const APP_EXE_NAME = "Selects.exe";

const WINDOWS_REGISTRY_PROBES: Array<{ hive: string; subkey: string; valueName: string }> = [
  { hive: "HKCU", subkey: "Software\\Selects", valueName: "InstallLocation" },
  { hive: "HKLM", subkey: "Software\\Selects", valueName: "InstallLocation" },
  {
    hive: "HKCU",
    subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Selects",
    valueName: "InstallLocation",
  },
  {
    hive: "HKLM",
    subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Selects",
    valueName: "InstallLocation",
  },
  {
    hive: "HKLM",
    subkey: "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Selects",
    valueName: "InstallLocation",
  },
];

interface LaunchAppArgs {
  wait_for_ready_seconds?: number;
}

export async function handleLaunchApp(
  rawArgs: Record<string, unknown> | undefined,
  config: BridgeConfig,
): Promise<ToolResultPayload> {
  const args = parseArgs(rawArgs ?? {});

  if (await healthCheck(config)) {
    return asToolSuccess(
      "Selects is already running. You can call other tools now.",
    );
  }

  const spawnResult = await spawnSelects();
  if (!spawnResult.ok) {
    return spawnResult.payload;
  }

  const ready = await pollUntilReady(config, args.waitSeconds);
  if (ready) {
    return asToolSuccess(
      "Selects has launched. Please retry the tool you wanted to call.",
    );
  }
  return launchTimeoutError(args.waitSeconds);
}

interface ParsedArgs {
  waitSeconds: number;
}

function parseArgs(args: Record<string, unknown>): ParsedArgs {
  const raw = args["wait_for_ready_seconds"];
  let waitSeconds = DEFAULT_WAIT_SECONDS;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    waitSeconds = Math.max(1, Math.min(MAX_WAIT_SECONDS, Math.floor(raw)));
  }
  return { waitSeconds };
}

type SpawnOutcome =
  | { ok: true }
  | { ok: false; payload: ToolResultPayload };

async function spawnSelects(): Promise<SpawnOutcome> {
  if (process.platform === "darwin") {
    return spawnDarwin();
  }
  if (process.platform === "win32") {
    return spawnWin32();
  }
  return { ok: false, payload: launchPlatformUnsupportedError(process.platform) };
}

function spawnDarwin(): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn("open", ["-a", APP_NAME], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        payload: isNotFound(error) ? appNotInstalledError() : launchSpawnError(error.message),
      });
    });
    child.on("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function spawnWin32(): Promise<SpawnOutcome> {
  const directAttempt = await tryStartByName();
  if (directAttempt.ok) return directAttempt;

  const installPath = await findWindowsInstallLocation();
  if (installPath) {
    const exePath = `${installPath}\\${APP_EXE_NAME}`;
    const result = await tryStartByPath(exePath);
    if (result.ok) return result;
  }

  return { ok: false, payload: appNotInstalledError() };
}

function tryStartByName(): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn("cmd", ["/c", "start", "", APP_NAME], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: false,
    });
    let resolved = false;
    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: false, payload: launchSpawnError(error.message) });
    });
    child.on("spawn", () => {
      if (resolved) return;
      resolved = true;
      child.unref();
      resolve({ ok: true });
    });
    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, payload: launchSpawnError(`exit code ${code}`) });
      }
    });
  });
}

function tryStartByPath(exePath: string): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(exePath, [], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        payload: isNotFound(error) ? appNotInstalledError() : launchSpawnError(error.message),
      });
    });
    child.on("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function findWindowsInstallLocation(): Promise<string | undefined> {
  for (const probe of WINDOWS_REGISTRY_PROBES) {
    const value = await readRegistryValue(probe.hive, probe.subkey, probe.valueName);
    if (value) return value;
  }
  return undefined;
}

function readRegistryValue(
  hive: string,
  subkey: string,
  valueName: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", `${hive}\\${subkey}`, "/v", valueName],
      { windowsHide: true, timeout: 2000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(undefined);
          return;
        }
        resolve(parseRegOutput(stdout, valueName));
      },
    );
  });
}

function parseRegOutput(output: string, valueName: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(valueName)) continue;
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length < 3) continue;
    const value = parts.slice(2).join("    ").trim();
    if (value) return value.replace(/\\$/, "");
  }
  return undefined;
}

interface NodeError extends Error {
  code?: string;
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeError).code;
  return code === "ENOENT";
}

async function pollUntilReady(config: BridgeConfig, waitSeconds: number): Promise<boolean> {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (await healthCheck(config)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function healthCheck(config: BridgeConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        method: "GET",
        host: config.host,
        port: config.port,
        path: config.path,
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
