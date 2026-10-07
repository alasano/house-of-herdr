import { describe, expect, it } from "vitest";
import {
  RING_AGENTS,
  RING_OFF,
  RING_SCROLL,
  slotLighting,
} from "../src/lights.js";

describe("dial-mode lighting", () => {
  it("uses orange for scroll, blue for agents, and off for workspaces", () => {
    expect(RING_SCROLL).toEqual({ e: 1, b: 0.5, s: 0, m: 0, c: 0xff8800 });
    expect(RING_AGENTS.c).toBe(0x2277ff);
    expect(RING_OFF.e).toBe(0);
    expect(RING_SCROLL.c).not.toBe(RING_AGENTS.c);
  });

  it("keeps agent status colors and effects independent of the ring", () => {
    expect(
      slotLighting(["blocked", "done", "working", "idle", "unknown", null]),
    ).toEqual([
      { id: 0, c: 0xffaa00, b: 1, e: 1, s: 0 },
      { id: 1, c: 0x22cc55, b: 1, e: 1, s: 0 },
      { id: 2, c: 0x2277ff, b: 1, e: 4, s: 0.35 },
      { id: 3, c: 0xffffff, b: 0.25, e: 1, s: 0 },
      { id: 4, c: 0xffffff, b: 0.08, e: 1, s: 0 },
      { id: 5, c: 0, b: 0, e: 0, s: 0 },
    ]);
  });
});
