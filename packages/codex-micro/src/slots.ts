// Slot assignment: which six agents occupy the six Agent Keys. Pure functions.
//
// "mirror" reproduces Herdr's sidebar priority order exactly: attention
// descending, then most recent state change first. Key N is always sidebar
// row N, so keys reshuffle as statuses change.
//
// "sticky" uses priority only for admission: an agent keeps its key through
// status changes, and a key is reassigned only when an unslotted agent has
// strictly higher attention than the lowest-attention slotted one.
export const SLOT_COUNT = 6;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type Policy = "sticky" | "mirror";

export interface SlotAgent {
  terminalId: string;
  status: AgentStatus;
  seq: number;
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

function byPriority(a: SlotAgent, b: SlotAgent): number {
  return attention(b.status) - attention(a.status) || b.seq - a.seq;
}

export function assignSlots(
  previous: (string | null)[],
  agents: SlotAgent[],
  policy: Policy,
): (string | null)[] {
  const sorted = [...agents].sort(byPriority);
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
    let victim = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const current = byId.get(slots[i] as string) as SlotAgent;
      if (
        victim === -1 ||
        byPriority(current, byId.get(slots[victim] as string) as SlotAgent) > 0
      ) {
        victim = i;
      }
    }
    const lowest = byId.get(slots[victim] as string) as SlotAgent;
    if (attention(candidate.status) > attention(lowest.status)) {
      slotted.delete(lowest.terminalId);
      slots[victim] = candidate.terminalId;
      slotted.add(candidate.terminalId);
    } else {
      break;
    }
  }
  return slots;
}
