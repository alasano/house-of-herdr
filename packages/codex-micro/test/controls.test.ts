import { beforeEach, describe, expect, it, vi } from "vitest";

// Dispatch must be exercised without driving the real keyboard.
const { posted } = vi.hoisted(() => ({ posted: [] as string[] }));
vi.mock("../src/tapkey.js", () => ({
  postKey: (combo: { keyCode: number; modifiers: number }, mode: string) =>
    posted.push(`${combo.keyCode}:${combo.modifiers} ${mode}`),
}));

const { Controls } = await import("../src/controls.js");
const { defaultBindings, resolveBindings } = await import("../src/bindings.js");
type Bindings = ReturnType<typeof defaultBindings>;
type HerdrStub = { request: ReturnType<typeof vi.fn> };

function setup(initial: Bindings = defaultBindings()) {
  let bindings = initial;
  const herdr: HerdrStub = { request: vi.fn(async () => ({})) };
  const deps = {
    bindings: () => bindings,
    slotPaneId: (slot: number) => `pane-${slot}`,
    togglePopup: vi.fn(),
    togglePolicy: vi.fn(),
    onDialModeChange: vi.fn(),
  };
  const logs: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controls = new Controls(herdr as any, deps, (message) =>
    logs.push(message),
  );
  return {
    controls,
    herdr,
    deps,
    logs,
    reload: (next: Bindings) => {
      bindings = next;
    },
  };
}

beforeEach(() => {
  posted.length = 0;
});

describe("hold bindings", () => {
  const holdOnAct10 = () => resolveBindings({ ACT10: { key: "rcmd" } });

  it("mirrors a physical press and release", () => {
    const { controls } = setup(holdOnAct10());
    controls.onHid("ACT10", 1);
    controls.onHid("ACT10", 0);
    expect(posted).toEqual(["54:0 down", "54:0 up"]);
  });

  it("releases the key it actually pressed after a config hot-reload", () => {
    // The release edge must resolve through what this input is holding, not
    // through the binding that replaced it, or the modifier stays down
    // system-wide until the device disconnects.
    const { controls, reload } = setup(holdOnAct10());
    controls.onHid("ACT10", 1);
    expect(posted).toEqual(["54:0 down"]);
    reload(resolveBindings({ ACT10: "zoom" }));
    controls.onHid("ACT10", 0);
    expect(posted).toEqual(["54:0 down", "54:0 up"]);
  });

  it("survives a reload that swaps one hold for another", () => {
    const { controls, reload } = setup(holdOnAct10());
    controls.onHid("ACT10", 1);
    reload(resolveBindings({ ACT10: { key: "lcmd" } }));
    controls.onHid("ACT10", 0);
    expect(posted).toEqual(["54:0 down", "54:0 up"]);
  });

  it("refcounts two inputs holding the same combo", () => {
    const { controls } = setup(
      resolveBindings({ ACT10: { key: "rcmd" }, ACT11: { key: "rcmd" } }),
    );
    controls.onHid("ACT10", 1);
    controls.onHid("ACT11", 1);
    expect(posted).toEqual(["54:0 down"]);
    // Releasing one must not end a hold the other still owns.
    controls.onHid("ACT10", 0);
    expect(posted).toEqual(["54:0 down"]);
    controls.onHid("ACT11", 0);
    expect(posted).toEqual(["54:0 down", "54:0 up"]);
  });

  it("ignores a repeated press without an intervening release", () => {
    const { controls } = setup(holdOnAct10());
    controls.onHid("ACT10", 1);
    controls.onHid("ACT10", 1);
    controls.onHid("ACT10", 0);
    expect(posted).toEqual(["54:0 down", "54:0 up"]);
  });

  it("releases everything held when the device goes away", () => {
    const { controls } = setup(
      resolveBindings({ ACT10: { key: "rcmd" }, ACT11: { key: "lcmd" } }),
    );
    controls.onHid("ACT10", 1);
    controls.onHid("ACT11", 1);
    posted.length = 0;
    controls.resetInputState();
    expect(posted.sort()).toEqual(["54:0 up", "55:0 up"]);
    // And the state is clean: a later release posts nothing.
    posted.length = 0;
    controls.onHid("ACT10", 0);
    expect(posted).toEqual([]);
  });
});

describe("tap bindings", () => {
  it("taps a non-hold key on press and does nothing on release", () => {
    const { controls } = setup(resolveBindings({ ACT10: { key: "f13" } }));
    controls.onHid("ACT10", 1);
    controls.onHid("ACT10", 0);
    expect(posted).toEqual(["105:0 tap"]);
  });

  it("taps once per dial tick", () => {
    const { controls } = setup(resolveBindings({ ENC_CW: { key: "f13" } }));
    controls.onHid("ENC_CW", 2);
    controls.onHid("ENC_CW", 2);
    expect(posted).toEqual(["105:0 tap", "105:0 tap"]);
  });
});

describe("agent keys", () => {
  it("focuses the slotted agent on press only", () => {
    const { controls, herdr } = setup();
    controls.onHid("AG02", 1);
    controls.onHid("AG02", 0);
    expect(herdr.request).toHaveBeenCalledTimes(1);
    expect(herdr.request).toHaveBeenCalledWith("agent.focus", {
      target: "pane-2",
    });
  });
});

describe("joystick", () => {
  it("needs a firm deflection to engage, then tracks the sweep", () => {
    const { controls, herdr } = setup();
    controls.onJoystick(0, 0.5); // past release, short of engage
    expect(herdr.request).not.toHaveBeenCalled();
    controls.onJoystick(0, 0.8);
    controls.onJoystick(0.25, 0.4); // still deflected: keeps sweeping
    expect(herdr.request.mock.calls.map((call) => call[1])).toEqual([
      { direction: "right" },
      { direction: "down" },
    ]);
  });

  it("does not refire while the stick stays in one sector", () => {
    const { controls, herdr } = setup();
    controls.onJoystick(0, 0.8);
    controls.onJoystick(0, 0.9);
    expect(herdr.request).toHaveBeenCalledTimes(1);
  });

  it("treats the ends of the turn as the same sector", () => {
    const { controls, herdr } = setup();
    controls.onJoystick(0.999, 0.8);
    controls.onJoystick(0, 0.8);
    expect(herdr.request).toHaveBeenCalledTimes(1);
    expect(herdr.request).toHaveBeenCalledWith("pane.focus_direction", {
      direction: "right",
    });
  });

  it("re-arms after returning to center", () => {
    const { controls, herdr } = setup();
    controls.onJoystick(0, 0.8);
    controls.onJoystick(0, 0.1); // centered
    controls.onJoystick(0, 0.8);
    expect(herdr.request).toHaveBeenCalledTimes(2);
  });

  it("forgets its sector when the device disconnects mid-deflection", () => {
    // Otherwise the next deflection into the same sector is swallowed.
    const { controls, herdr } = setup();
    controls.onJoystick(0, 0.8);
    controls.resetInputState();
    controls.onJoystick(0, 0.8);
    expect(herdr.request).toHaveBeenCalledTimes(2);
  });
});

describe("error containment", () => {
  it("logs and survives a binding lookup that throws", () => {
    // onHid runs straight off the HID stream; a throw here would take the
    // whole daemon down.
    const { controls, logs } = setup();
    const broken = {
      get buttons(): never {
        throw new Error("config exploded");
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controls as any).deps.bindings = () => broken;
    expect(() => controls.onHid("ACT10", 1)).not.toThrow();
    expect(logs.join()).toMatch(/config exploded/);
  });
});
