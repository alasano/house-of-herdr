import { describe, expect, it } from "vitest";
import { SLOT_COUNT, assignSlots, type SlotAgent } from "../src/slots.js";

function agent(
  terminalId: string,
  status: SlotAgent["status"],
  seq: number,
): SlotAgent {
  return { terminalId, status, seq };
}

const EMPTY = Array.from({ length: SLOT_COUNT }, () => null);

describe("mirror policy", () => {
  it("orders slots by attention then recency, exactly like the sidebar", () => {
    const agents = [
      agent("idle-old", "idle", 1),
      agent("working", "working", 5),
      agent("blocked", "blocked", 2),
      agent("done", "done", 3),
      agent("idle-new", "idle", 9),
    ];
    expect(assignSlots(EMPTY, agents, "mirror")).toEqual([
      "blocked",
      "done",
      "working",
      "idle-new",
      "idle-old",
      null,
    ]);
  });

  it("reshuffles when a status change reorders priorities", () => {
    const before = [agent("a", "blocked", 1), agent("b", "done", 2)];
    const first = assignSlots(EMPTY, before, "mirror");
    expect(first.slice(0, 2)).toEqual(["a", "b"]);
    const after = [agent("a", "idle", 3), agent("b", "done", 2)];
    expect(assignSlots(first, after, "mirror").slice(0, 2)).toEqual(["b", "a"]);
  });
});

describe("sticky policy", () => {
  it("keeps an agent on its key through status changes", () => {
    const first = assignSlots(
      EMPTY,
      [agent("a", "blocked", 1), agent("b", "working", 2)],
      "sticky",
    );
    expect(first.slice(0, 2)).toEqual(["a", "b"]);
    const second = assignSlots(
      first,
      [agent("a", "idle", 3), agent("b", "blocked", 4)],
      "sticky",
    );
    expect(second.slice(0, 2)).toEqual(["a", "b"]);
  });

  it("leaves other keys in place when a slotted agent disappears", () => {
    const agents = [
      agent("a", "idle", 1),
      agent("b", "idle", 2),
      agent("c", "idle", 3),
    ];
    const first = assignSlots(EMPTY, agents, "sticky");
    expect(first.slice(0, 3)).toEqual(["c", "b", "a"]);
    const second = assignSlots(
      first,
      [agent("a", "idle", 1), agent("c", "idle", 3)],
      "sticky",
    );
    expect(second.slice(0, 3)).toEqual(["c", null, "a"]);
  });

  it("evicts the lowest-attention slotted agent only for a strictly needier one", () => {
    const six = [
      agent("s1", "blocked", 1),
      agent("s2", "done", 2),
      agent("s3", "working", 3),
      agent("s4", "working", 4),
      agent("s5", "idle", 5),
      agent("s6", "idle", 6),
    ];
    const slots = assignSlots(EMPTY, six, "sticky");

    const withEqualNewcomer = assignSlots(
      slots,
      [...six, agent("n1", "idle", 7)],
      "sticky",
    );
    expect(withEqualNewcomer).toEqual(slots);

    const withNeedierNewcomer = assignSlots(
      slots,
      [...six, agent("n2", "blocked", 8)],
      "sticky",
    );
    expect(withNeedierNewcomer).toContain("n2");
    // The oldest idle agent loses its key; everyone else stays put.
    expect(withNeedierNewcomer.filter((id) => id !== "n2")).toEqual(
      slots.filter((id) => id !== "s5"),
    );
  });

  it("fills empty keys by priority order", () => {
    const agents = [
      agent("idle", "idle", 1),
      agent("blocked", "blocked", 2),
      agent("working", "working", 3),
    ];
    const slots = assignSlots(EMPTY, agents, "sticky");
    expect(slots).toEqual(["blocked", "working", "idle", null, null, null]);
  });

  it("admits every needier newcomer in one pass, not just the first", () => {
    // Admission continues down the sorted candidates until one fails to beat
    // the weakest occupant. Stopping after the first eviction would leave the
    // second blocked agent dark while an idle one kept its key.
    const six = [
      agent("s1", "working", 1),
      agent("s2", "working", 2),
      agent("s3", "idle", 3),
      agent("s4", "idle", 4),
      agent("s5", "idle", 5),
      agent("s6", "idle", 6),
    ];
    const slots = assignSlots(EMPTY, six, "sticky");
    const after = assignSlots(
      slots,
      [...six, agent("n1", "blocked", 7), agent("n2", "blocked", 8)],
      "sticky",
    );
    expect(after).toContain("n1");
    expect(after).toContain("n2");
    // Exactly the two oldest idle agents lost their keys.
    expect(after.filter((id) => id !== null).sort()).toEqual([
      "n1",
      "n2",
      "s1",
      "s2",
      "s5",
      "s6",
    ]);
  });

  it("stops admitting once a candidate cannot beat the weakest occupant", () => {
    const six = [
      agent("s1", "blocked", 1),
      agent("s2", "blocked", 2),
      agent("s3", "blocked", 3),
      agent("s4", "blocked", 4),
      agent("s5", "blocked", 5),
      agent("s6", "blocked", 6),
    ];
    const slots = assignSlots(EMPTY, six, "sticky");
    const after = assignSlots(
      slots,
      [...six, agent("n1", "blocked", 7), agent("n2", "done", 8)],
      "sticky",
    );
    expect(after).toEqual(slots);
  });

  it("refills a hole left by a departed agent with the neediest newcomer", () => {
    const six = [
      agent("s1", "idle", 1),
      agent("s2", "idle", 2),
      agent("s3", "idle", 3),
      agent("s4", "idle", 4),
      agent("s5", "idle", 5),
      agent("s6", "idle", 6),
    ];
    const slots = assignSlots(EMPTY, six, "sticky");
    const holeIndex = slots.indexOf("s3");
    const remaining = six.filter((a) => a.terminalId !== "s3");
    const after = assignSlots(
      slots,
      [...remaining, agent("n1", "idle", 7), agent("n2", "blocked", 8)],
      "sticky",
    );
    // The vacated key takes the neediest waiting agent, and nothing else moves.
    expect(after[holeIndex]).toBe("n2");
    expect(after.filter((id) => id !== null)).toHaveLength(6);
    slots.forEach((id, i) => {
      if (i !== holeIndex) expect(after[i]).toBe(id);
    });
  });
});
