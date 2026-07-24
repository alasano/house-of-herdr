// Binding resolution: which action each physical input triggers. Config
// entries override per input; omitted inputs keep their defaults; "none"
// disables. Validation fails loudly naming the offending entry so a config
// author (human or LLM) can self-correct from the error alone.
import { isModifierKey, parseKeyCombo, type KeyCombo } from "./keys.js";

export type Preset =
  | "popup"
  | "tab-next"
  | "tab-prev"
  | "tab-new"
  | "workspace-next"
  | "workspace-prev"
  | "zoom"
  | "pane-split-right"
  | "pane-split-down"
  | "agent-next"
  | "agent-prev"
  | "toggle-policy"
  | "dial-next"
  | "dial-prev"
  | "dial-mode";

export type Binding =
  | { kind: "preset"; preset: Preset }
  | { kind: "key"; combo: KeyCombo; hold: boolean }
  | { kind: "herdr-key"; keys: string }
  | { kind: "herdr-text"; text: string }
  | { kind: "exec"; argv: string[] }
  | { kind: "none" };

const PRESETS: Preset[] = [
  "popup",
  "tab-next",
  "tab-prev",
  "tab-new",
  "workspace-next",
  "workspace-prev",
  "zoom",
  "pane-split-right",
  "pane-split-down",
  "agent-next",
  "agent-prev",
  "toggle-policy",
  "dial-next",
  "dial-prev",
  "dial-mode",
];

const BUTTON_INPUTS = [
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10",
  "ACT11",
  "ACT12",
  "ENC_CW",
  "ENC_CC",
  "ENC_CLK",
] as const;
const JOYSTICK_DIRECTIONS = ["up", "down", "left", "right"] as const;

export type ButtonInput = (typeof BUTTON_INPUTS)[number];
export type JoystickDirection = (typeof JOYSTICK_DIRECTIONS)[number];

export interface Bindings {
  buttons: Record<ButtonInput, Binding>;
  /** null = the pane-nav preset (sweep pane focus) for that direction. */
  joystick: Record<JoystickDirection, Binding | null>;
}

const NONE: Binding = { kind: "none" };
const preset = (name: Preset): Binding => ({ kind: "preset", preset: name });

export function defaultBindings(): Bindings {
  return {
    buttons: {
      ACT06: preset("popup"),
      ACT07: { kind: "herdr-key", keys: "esc" },
      ACT08: preset("tab-prev"),
      ACT09: preset("tab-next"),
      ACT10: NONE,
      ACT11: NONE,
      ACT12: { kind: "herdr-key", keys: "enter" },
      ENC_CW: preset("dial-prev"),
      ENC_CC: preset("dial-next"),
      ENC_CLK: preset("dial-mode"),
    },
    joystick: { up: null, down: null, left: null, right: null },
  };
}

function parseBinding(entry: string, value: unknown): Binding {
  if (typeof value === "string") {
    if (value === "none") return NONE;
    if ((PRESETS as string[]).includes(value)) return preset(value as Preset);
    throw new Error(
      `bindings.${entry}: unknown preset "${value}" (valid: none, ${PRESETS.join(", ")})`,
    );
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.key === "string") {
      try {
        const combo = parseKeyCombo(record.key);
        // Bare modifiers always mirror the physical hold (a 30ms modifier
        // blip is useless); other keys hold only when asked.
        return {
          kind: "key",
          combo,
          hold: isModifierKey(combo.keyCode) || record.hold === true,
        };
      } catch (error) {
        throw new Error(`bindings.${entry}: ${(error as Error).message}`);
      }
    }
    if (
      typeof record["herdr-key"] === "string" &&
      record["herdr-key"].length > 0
    ) {
      return { kind: "herdr-key", keys: record["herdr-key"] };
    }
    if (
      typeof record["herdr-text"] === "string" &&
      record["herdr-text"].length > 0
    ) {
      return { kind: "herdr-text", text: record["herdr-text"] };
    }
    if (Array.isArray(record.exec) && record.exec.length > 0) {
      if (!record.exec.every((arg) => typeof arg === "string")) {
        throw new Error(`bindings.${entry}: exec must be an array of strings`);
      }
      return { kind: "exec", argv: record.exec as string[] };
    }
  }
  throw new Error(
    `bindings.${entry}: expected a preset name, {"key"}, {"herdr-key"}, {"herdr-text"}, or {"exec"}`,
  );
}

export function resolveBindings(raw: unknown): Bindings {
  const bindings = defaultBindings();
  if (raw === undefined) return bindings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("bindings: expected an object");
  }
  for (const [entry, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((BUTTON_INPUTS as readonly string[]).includes(entry)) {
      bindings.buttons[entry as ButtonInput] = parseBinding(entry, value);
    } else if (entry === "joystick") {
      resolveJoystick(bindings, value);
    } else {
      throw new Error(
        `bindings: unknown input "${entry}" (valid: ${BUTTON_INPUTS.join(", ")}, joystick)`,
      );
    }
  }
  return bindings;
}

function resolveJoystick(bindings: Bindings, value: unknown): void {
  if (value === "pane-nav") return; // the default
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      'bindings.joystick: expected "pane-nav" or {up, down, left, right}',
    );
  }
  for (const [direction, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!(JOYSTICK_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new Error(`bindings.joystick: unknown direction "${direction}"`);
    }
    bindings.joystick[direction as JoystickDirection] =
      entry === "pane-nav"
        ? null
        : parseBinding(`joystick.${direction}`, entry);
  }
}
