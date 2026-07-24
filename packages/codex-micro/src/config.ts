// Plugin file locations and persisted settings. Herdr-provided plugin dirs
// win; the fallbacks mirror Herdr's own plugin path layout so manual launches
// resolve the same locations as hook/action/pane launches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBindings, type Bindings } from "./bindings.js";
import type { Policy } from "./slots.js";

export const PLUGIN_ID = "alasano.codex-micro";

export const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ??
  path.join(os.homedir(), ".config", "herdr", "plugins", "config", PLUGIN_ID);
const stateDir =
  process.env.HERDR_PLUGIN_STATE_DIR ??
  path.join(os.homedir(), ".local", "state", "herdr", "plugins", PLUGIN_ID);
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LEGACY_CONFIG_FILE = path.join(
  os.homedir(),
  ".config",
  "house-of-herdr",
  "codex-micro.json",
);

export const CONTROL_SOCKET = path.join(stateDir, "control.sock");
export const LOG_FILE = path.join(stateDir, "daemon.log");

export interface Config {
  policy: Policy;
  bindings: Bindings;
}

// Throws with an entry-naming message on invalid bindings; the caller decides
// whether to fall back to defaults (daemon) or abort (nothing else loads it).
export function loadConfig(): Config {
  migrateLegacyConfig();
  const raw = readRawConfig();
  return {
    policy: raw.policy === "mirror" ? "mirror" : "sticky",
    bindings: resolveBindings(raw.bindings),
  };
}

// Read-modify-write preserving fields this writer does not own (bindings and
// anything a future version adds).
export function savePolicy(policy: Policy): void {
  const raw = readRawConfig();
  raw.policy = policy;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_FILE);
}

export function ensureStateDir(): void {
  fs.mkdirSync(stateDir, { recursive: true });
}

function readRawConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function migrateLegacyConfig(): void {
  try {
    if (fs.existsSync(CONFIG_FILE) || !fs.existsSync(LEGACY_CONFIG_FILE))
      return;
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_FILE);
  } catch {
    // fall back to defaults; migration is best-effort
  }
}
