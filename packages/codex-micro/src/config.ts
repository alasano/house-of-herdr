// Plugin file locations and persisted settings. Herdr-provided plugin dirs
// win; the fallbacks mirror Herdr's own plugin path layout so manual launches
// resolve the same locations as hook/action/pane launches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBindings, type Bindings } from "./bindings.js";
import { DEFAULT_DIAL_MODE_ORDER, DIAL_MODES, type DialMode } from "./dial.js";
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
  activateTerminalOnAgentFocus: boolean;
  scrollSteps: number;
  dialModeOrder: DialMode[];
  bindings: Bindings;
}

// Throws with an entry-naming message on any invalid config - unparseable
// JSON, a non-object root, an unknown policy, or a bad binding. The caller
// decides whether to fall back to the last good state (daemon) or abort.
export function loadConfig(): Config {
  migrateLegacyConfig();
  const raw = readRawConfig();
  return {
    policy: resolvePolicy(raw.policy),
    activateTerminalOnAgentFocus: resolveBoolean(
      raw.activateTerminalOnAgentFocus,
      "activateTerminalOnAgentFocus",
    ),
    scrollSteps: resolveScrollSteps(raw.scroll_steps),
    dialModeOrder: resolveDialModeOrder(raw.dial_mode_order),
    bindings: resolveBindings(raw.bindings),
  };
}

// Read-modify-write preserving fields this writer does not own (bindings and
// anything a future version adds). Propagates the read error rather than
// treating an unreadable file as empty: writing over a config we could not
// parse would silently delete every binding in it.
export function savePolicy(policy: Policy): void {
  const raw = readRawConfig();
  raw.policy = policy;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_FILE);
}

// Both dirs, because the daemon watches CONFIG_DIR: watching a directory that
// does not exist fails permanently, and Herdr only pre-creates it for plugin
// launches it owns.
export function ensurePluginDirs(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
}

function resolvePolicy(value: unknown): Policy {
  if (value === undefined) return "sticky";
  if (value === "sticky" || value === "mirror") return value;
  throw new Error(
    `policy: expected "sticky" or "mirror", got ${JSON.stringify(value)}`,
  );
}

function resolveBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new Error(
    `${name}: expected true or false, got ${JSON.stringify(value)}`,
  );
}

function resolveScrollSteps(value: unknown): number {
  if (value === undefined) return 1;
  if (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 12
  ) {
    return value as number;
  }
  throw new Error(
    `scroll_steps: expected an integer from 1 to 12, got ${JSON.stringify(value)}`,
  );
}

function resolveDialModeOrder(value: unknown): DialMode[] {
  if (value === undefined) return [...DEFAULT_DIAL_MODE_ORDER];
  const validModes = DIAL_MODES as readonly unknown[];
  if (
    !Array.isArray(value) ||
    value.length !== DIAL_MODES.length ||
    !value.every((mode) => validModes.includes(mode)) ||
    new Set(value).size !== DIAL_MODES.length
  ) {
    throw new Error(
      `dial_mode_order: expected each of ${DIAL_MODES.join(", ")} exactly once, got ${JSON.stringify(value)}`,
    );
  }
  return value as DialMode[];
}

function readRawConfig(): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(CONFIG_FILE, "utf8");
  } catch (error) {
    // Only "no config yet" is a normal state; anything else is a real fault.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read ${CONFIG_FILE}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
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
