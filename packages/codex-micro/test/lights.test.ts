import { describe, expect, it } from "vitest";
import { slotLighting } from "../src/lights.js";
import { SLOT_COUNT, type AgentStatus } from "../src/slots.js";

const BREATH = 4;
const SOLID = 1;
const OFF = 0;

function statuses(...values: (AgentStatus | null)[]): (AgentStatus | null)[] {
  const padded = [...values];
  while (padded.length < SLOT_COUNT) padded.push(null);
  return padded;
}

describe("status lighting", () => {
  it("keeps every status solid when nothing is focused", () => {
    const lighting = slotLighting(
      statuses("working", "blocked", "done", "idle", "unknown"),
    );
    for (const slot of lighting.slice(0, 5)) {
      expect(slot.e).toBe(SOLID);
      expect(slot.s).toBe(0);
    }
  });

  it("leaves unoccupied slots off", () => {
    const lighting = slotLighting(statuses("working"));
    expect(lighting[1]).toEqual({ id: 1, c: 0, b: 0, e: OFF, s: 0 });
  });

  it("gives each status its own color", () => {
    const lighting = slotLighting(statuses("blocked", "done", "working"));
    expect(lighting[0]!.c).toBe(0xffaa00);
    expect(lighting[1]!.c).toBe(0x22cc55);
    expect(lighting[2]!.c).toBe(0x2277ff);
  });
});

describe("focus indicator", () => {
  it("breathes only the focused slot", () => {
    const lighting = slotLighting(statuses("working", "working", "working"), 1);
    expect(lighting.map((slot) => slot.e)).toEqual([
      SOLID,
      BREATH,
      SOLID,
      OFF,
      OFF,
      OFF,
    ]);
  });

  it("keeps the focused slot's status color", () => {
    const lighting = slotLighting(statuses("blocked", "idle"), 0);
    expect(lighting[0]!.c).toBe(0xffaa00);
    expect(lighting[0]!.e).toBe(BREATH);
  });

  it("raises dim statuses to full brightness so the breath is visible", () => {
    const unfocused = slotLighting(statuses("idle", "unknown"));
    expect(unfocused[0]!.b).toBe(0.25);
    expect(unfocused[1]!.b).toBe(0.08);

    expect(slotLighting(statuses("idle"), 0)[0]!.b).toBe(1);
    expect(slotLighting(statuses("unknown"), 0)[0]!.b).toBe(1);
  });

  it("stays all-solid when the focused pane is not slotted", () => {
    const lighting = slotLighting(statuses("working", "idle"), null);
    expect(lighting.every((slot) => slot.e !== BREATH)).toBe(true);
  });

  it("never lights an empty slot, even if it is somehow focused", () => {
    const lighting = slotLighting(statuses("working"), 3);
    expect(lighting[3]).toEqual({ id: 3, c: 0, b: 0, e: OFF, s: 0 });
  });
});
