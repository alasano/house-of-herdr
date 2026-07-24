// Status to lighting translation for the six Agent Key LEDs.
import type { ThreadLighting } from "./device.js";
import { SLOT_COUNT, type AgentStatus } from "./slots.js";

const EFFECT = { off: 0, solid: 1, breath: 4 } as const;

export const STATUS_COLORS: Record<AgentStatus, number> = {
  blocked: 0xffaa00,
  done: 0x22cc55,
  working: 0x2277ff,
  idle: 0xffffff,
  unknown: 0xffffff,
};

const STATUS_LIGHTING: Record<AgentStatus, Omit<ThreadLighting, "id">> = {
  blocked: { c: STATUS_COLORS.blocked, b: 1, e: EFFECT.solid, s: 0 },
  done: { c: STATUS_COLORS.done, b: 1, e: EFFECT.solid, s: 0 },
  working: { c: STATUS_COLORS.working, b: 1, e: EFFECT.breath, s: 0.35 },
  idle: { c: STATUS_COLORS.idle, b: 0.25, e: EFFECT.solid, s: 0 },
  unknown: { c: STATUS_COLORS.unknown, b: 0.08, e: EFFECT.solid, s: 0 },
};

const OFF: Omit<ThreadLighting, "id"> = { c: 0, b: 0, e: EFFECT.off, s: 0 };

export function slotLighting(
  statuses: (AgentStatus | null)[],
): ThreadLighting[] {
  return Array.from({ length: SLOT_COUNT }, (_, id) => {
    const status = statuses[id] ?? null;
    return { id, ...(status ? STATUS_LIGHTING[status] : OFF) };
  });
}
