// Binding resolution: which action each physical input triggers. Config
// entries override per input; omitted inputs keep their defaults; "none"
// disables. Validation fails loudly naming the offending entry so a config
// author (human or LLM) can self-correct from the error alone.
import { isModifierKey, parseKeyCombo, type KeyCombo } from "./keys.js";

const PRESETS = [
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
] as const;

export type Preset = (typeof PRESETS)[number];

export type Binding =
  | { kind: "preset"; preset: Preset }
  | { kind: "key"; combo: KeyCombo; hold: boolean }
  | { kind: "herdr-key"; keys: string }
  | { kind: "herdr-text"; text: string }
  | { kind: "exec"; argv: string[] }
  | { kind: "none" };

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

// Inputs that report a press but no matching release. A held key bound here
// could never be released, so the parser rejects holds instead of silently
// degrading them to a 30ms blip.
const EDGELESS_INPUTS: readonly string[] = ["ENC_CW", "ENC_CC"];

export type ButtonInput = (typeof BUTTON_INPUTS)[number];
export type JoystickDirection = (typeof JOYSTICK_DIRECTIONS)[number];

export interface Bindings {
  buttons: Record<ButtonInput, Binding>;
  /** null = the pane-nav preset (sweep pane focus) for that direction. */
  joystick: Record<JoystickDirection, Binding | null>;
}

const NONE: Binding = { kind: "none" };
const preset = (name: Preset): Binding => ({ kind: "preset", preset: name });

const BINDING_KEYS = ["key", "herdr-key", "herdr-text", "exec"] as const;

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

function parseKeyBinding(
  entry: string,
  record: Record<string, unknown>,
  supportsHold: boolean,
): Binding {
  if (record.hold !== undefined && typeof record.hold !== "boolean") {
    throw new Error(
      `bindings.${entry}: "hold" must be true or false, got ${JSON.stringify(record.hold)}`,
    );
  }
  let combo: KeyCombo;
  try {
    combo = parseKeyCombo(record.key as string);
  } catch (error) {
    throw new Error(`bindings.${entry}: ${(error as Error).message}`);
  }
  // Bare modifiers always mirror the physical hold (a 30ms modifier blip is
  // useless); other keys hold only when asked.
  const hold = isModifierKey(combo.keyCode) || record.hold === true;
  if (hold && !supportsHold) {
    throw new Error(
      `bindings.${entry}: hold bindings need a release edge, which ${entry} does not report` +
        (isModifierKey(combo.keyCode)
          ? ` (bare modifier keys always hold); use a regular key here, or bind it to ENC_CLK or a command key`
          : `; drop "hold", or bind it to ENC_CLK or a command key`),
    );
  }
  return { kind: "key", combo, hold };
}

function parseBinding(
  entry: string,
  value: unknown,
  supportsHold: boolean,
): Binding {
  if (typeof value === "string") {
    if (value === "none") return NONE;
    if ((PRESETS as readonly string[]).includes(value)) {
      return preset(value as Preset);
    }
    throw new Error(
      `bindings.${entry}: unknown preset "${value}" (valid: none, ${PRESETS.join(", ")})`,
    );
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    // An object naming two actions has no defensible interpretation; picking
    // the first recognized one would silently drop the author's intent.
    const declared = BINDING_KEYS.filter((key) => record[key] !== undefined);
    if (declared.length > 1) {
      throw new Error(
        `bindings.${entry}: expected exactly one of ${BINDING_KEYS.join(", ")}, got ${declared.join(" + ")}`,
      );
    }
    if (typeof record.key === "string") {
      return parseKeyBinding(entry, record, supportsHold);
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
      const argv = record.exec as string[];
      // spawn("") throws synchronously, before any error handler can catch it.
      if (argv[0]!.trim().length === 0) {
        throw new Error(`bindings.${entry}: exec command must not be empty`);
      }
      return { kind: "exec", argv };
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
      bindings.buttons[entry as ButtonInput] = parseBinding(
        entry,
        value,
        !EDGELESS_INPUTS.includes(entry),
      );
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
        : // A joystick sector reports entry, not release: no hold edge either.
          parseBinding(`joystick.${direction}`, entry, false);
  }
}
