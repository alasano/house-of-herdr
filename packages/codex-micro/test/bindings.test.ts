import { describe, expect, it } from "vitest";
import { parseKeyCombo } from "../src/keys.js";
import { defaultBindings, resolveBindings } from "../src/bindings.js";

describe("parseKeyCombo", () => {
  it("parses a bare key", () => {
    expect(parseKeyCombo("return")).toEqual({ keyCode: 36, modifiers: 0 });
  });

  it("parses modifier combos with aliases", () => {
    expect(parseKeyCombo("cmd+shift+p")).toEqual({ keyCode: 35, modifiers: 3 });
    expect(parseKeyCombo("CTRL+Opt+F13")).toEqual({
      keyCode: 105,
      modifiers: 12,
    });
  });

  it("accepts bare modifiers alone and rejects them in combos", () => {
    expect(parseKeyCombo("rcmd")).toEqual({ keyCode: 54, modifiers: 0 });
    expect(parseKeyCombo("ropt")).toEqual({ keyCode: 61, modifiers: 0 });
    expect(() => parseKeyCombo("shift+rcmd")).toThrow(/must be used alone/);
  });

  it("names the unknown token in errors", () => {
    expect(() => parseKeyCombo("hyper+p")).toThrow(/unknown modifier "hyper"/);
    expect(() => parseKeyCombo("cmd+florb")).toThrow(/unknown key "florb"/);
  });
});

describe("resolveBindings", () => {
  it("returns defaults when the section is omitted", () => {
    expect(resolveBindings(undefined)).toEqual(defaultBindings());
  });

  it("overrides only the configured inputs", () => {
    const bindings = resolveBindings({
      ACT10: { key: "rcmd" },
      ACT12: { key: "return" },
    });
    // Bare modifiers hold implicitly; regular keys tap unless asked to hold.
    expect(bindings.buttons.ACT10).toEqual({
      kind: "key",
      combo: { keyCode: 54, modifiers: 0 },
      hold: true,
    });
    expect(bindings.buttons.ACT12).toEqual({
      kind: "key",
      combo: { keyCode: 36, modifiers: 0 },
      hold: false,
    });
    expect(bindings.buttons.ACT06).toEqual(defaultBindings().buttons.ACT06);
  });

  it("holds a combo when asked", () => {
    const bindings = resolveBindings({
      ACT10: { key: "cmd+shift+v", hold: true },
    });
    expect(bindings.buttons.ACT10).toEqual({
      kind: "key",
      combo: { keyCode: 9, modifiers: 3 },
      hold: true,
    });
  });

  it("parses every binding kind", () => {
    const bindings = resolveBindings({
      ACT06: "zoom",
      ACT07: { "herdr-key": "ctrl+c" },
      ACT08: { "herdr-text": "continue" },
      ACT09: { exec: ["open", "x-app://run"] },
      ACT10: "none",
    });
    expect(bindings.buttons.ACT06).toEqual({ kind: "preset", preset: "zoom" });
    expect(bindings.buttons.ACT07).toEqual({
      kind: "herdr-key",
      keys: "ctrl+c",
    });
    expect(bindings.buttons.ACT08).toEqual({
      kind: "herdr-text",
      text: "continue",
    });
    expect(bindings.buttons.ACT09).toEqual({
      kind: "exec",
      argv: ["open", "x-app://run"],
    });
    expect(bindings.buttons.ACT10).toEqual({ kind: "none" });
  });

  it("overrides a single joystick direction, keeping pane-nav on the rest", () => {
    const bindings = resolveBindings({ joystick: { up: { key: "f13" } } });
    expect(bindings.joystick.up).toEqual({
      kind: "key",
      combo: { keyCode: 105, modifiers: 0 },
      hold: false,
    });
    expect(bindings.joystick.down).toBe(null);
  });

  it("rejects unknown inputs, presets, and shapes with the entry named", () => {
    expect(() => resolveBindings({ ACT99: "zoom" })).toThrow(
      /unknown input "ACT99"/,
    );
    expect(() => resolveBindings({ ACT06: "warp-speed" })).toThrow(
      /bindings.ACT06: unknown preset "warp-speed"/,
    );
    expect(() => resolveBindings({ ACT06: 42 })).toThrow(
      /bindings.ACT06: expected/,
    );
    expect(() => resolveBindings({ joystick: { diagonal: "zoom" } })).toThrow(
      /unknown direction "diagonal"/,
    );
    expect(() => resolveBindings({ ACT07: { key: "cmd+florb" } })).toThrow(
      /bindings.ACT07: unknown key "florb"/,
    );
  });

  it("rejects holds on inputs that never report a release", () => {
    // Dial rotation and joystick sectors fire once; a hold bound there could
    // only ever be a 30ms blip, which is not what the author asked for.
    expect(() => resolveBindings({ ENC_CW: { key: "rcmd" } })).toThrow(
      /bindings.ENC_CW: hold bindings need a release edge/,
    );
    expect(() =>
      resolveBindings({ ENC_CC: { key: "cmd+v", hold: true } }),
    ).toThrow(/bindings.ENC_CC: hold bindings need a release edge/);
    expect(() =>
      resolveBindings({ joystick: { up: { key: "rcmd" } } }),
    ).toThrow(/bindings.joystick.up: hold bindings need a release edge/);
    // The dial click does have both edges.
    expect(
      resolveBindings({ ENC_CLK: { key: "rcmd" } }).buttons.ENC_CLK,
    ).toEqual({
      kind: "key",
      combo: { keyCode: 54, modifiers: 0 },
      hold: true,
    });
    // Taps remain fine on the edgeless inputs.
    expect(resolveBindings({ ENC_CW: { key: "f13" } }).buttons.ENC_CW).toEqual({
      kind: "key",
      combo: { keyCode: 105, modifiers: 0 },
      hold: false,
    });
  });

  it("rejects a non-boolean hold instead of silently tapping", () => {
    expect(() =>
      resolveBindings({ ACT10: { key: "f13", hold: "true" } }),
    ).toThrow(/bindings.ACT10: "hold" must be true or false/);
  });

  it("rejects an object declaring more than one action", () => {
    expect(() =>
      resolveBindings({ ACT10: { key: "f13", "herdr-key": "esc" } }),
    ).toThrow(/bindings.ACT10: expected exactly one of/);
  });

  it("rejects an exec command that would crash the spawn", () => {
    expect(() => resolveBindings({ ACT10: { exec: [""] } })).toThrow(
      /bindings.ACT10: exec command must not be empty/,
    );
    expect(() => resolveBindings({ ACT10: { exec: ["  "] } })).toThrow(
      /bindings.ACT10: exec command must not be empty/,
    );
    expect(() => resolveBindings({ ACT10: { exec: ["open", 5] } })).toThrow(
      /bindings.ACT10: exec must be an array of strings/,
    );
  });
});
