// Slot assignment: which six agents occupy the six Agent Keys. Pure functions.
//
// Both policies rank agents by Herdr's attention priority: attention
// descending, then most recent state change first. That is the same ordering
// Herdr's sidebar uses when it is configured to sort by priority; Herdr's
// default sidebar sort is by space, so the keys will not always mirror the
// sidebar's visible row order.
//
// "mirror" applies that ranking directly: key N is rank N, so keys reshuffle
// as statuses change.
//
// "sticky" uses the ranking only for admission: an agent keeps its key
// through status changes, and a key is reassigned only when an unslotted
// agent has strictly higher attention than the lowest-attention slotted one.
export const SLOT_COUNT = 6;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type Policy = "sticky" | "mirror";

/** The minimum an agent must expose to be ranked. */
export interface Prioritized {
  status: AgentStatus;
  seq: number;
}

export interface SlotAgent extends Prioritized {
  terminalId: string;
}

// Matches Herdr's tab_attention_priority.
export function attention(status: AgentStatus): number {
  switch (status) {
    case "blocked":
      return 4;
    case "done":
      return 3;
    case "working":
      return 2;
    case "idle":
      return 1;
    case "unknown":
      return 0;
  }
}

/** Neediest first, then most recently changed. */
export function comparePriority(a: Prioritized, b: Prioritized): number {
  return attention(b.status) - attention(a.status) || b.seq - a.seq;
}

export function assignSlots(
  previous: (string | null)[],
  agents: SlotAgent[],
  policy: Policy,
): (string | null)[] {
  const sorted = [...agents].sort(comparePriority);
  if (policy === "mirror") {
    const slots: (string | null)[] = sorted
      .slice(0, SLOT_COUNT)
      .map((agent) => agent.terminalId);
    while (slots.length < SLOT_COUNT) slots.push(null);
    return slots;
  }

  const byId = new Map(agents.map((agent) => [agent.terminalId, agent]));
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => {
    const id = previous[i] ?? null;
    return id !== null && byId.has(id) ? id : null;
  });
  const slotted = new Set(slots.filter((id): id is string => id !== null));

  for (const candidate of sorted) {
    if (slotted.has(candidate.terminalId)) continue;
    const empty = slots.indexOf(null);
    if (empty !== -1) {
      slots[empty] = candidate.terminalId;
      slotted.add(candidate.terminalId);
      continue;
    }
    // Every slot is filled here, so the least needy occupant is the one to
    // displace. Resolving through the map keeps this honest about the
    // possibility of a missing entry instead of asserting it away.
    let victim: { index: number; agent: SlotAgent } | null = null;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const id = slots[i];
      if (id === null || id === undefined) continue;
      const agent = byId.get(id);
      if (!agent) continue;
      if (victim === null || comparePriority(agent, victim.agent) > 0) {
        victim = { index: i, agent };
      }
    }
    if (victim === null) break;
    // Sorted candidates only get less needy, so the first one that fails to
    // beat the weakest occupant ends admission.
    if (attention(candidate.status) <= attention(victim.agent.status)) break;
    slotted.delete(victim.agent.terminalId);
    slots[victim.index] = candidate.terminalId;
    slotted.add(candidate.terminalId);
  }
  return slots;
}
