import { describe, expect, it } from "vitest";
import { MARGIN, layout } from "../src/popup-layout.js";

// The bottom row is four boxes wide; if it does not fit the pane, every line
// wraps and the wrapped tails draw phantom frames under the first box.
describe("popup layout", () => {
  it("keeps the design width on a wide pane", () => {
    expect(layout(160).cell).toBe(36);
    expect(layout(400).cell).toBe(36);
  });

  it("shrinks the boxes so the grid fits a narrower pane", () => {
    const narrow = layout(130);
    expect(narrow.cell).toBe(29);
    expect(MARGIN + narrow.grid).toBeLessThanOrEqual(130);
  });

  it("stops shrinking at the readable floor", () => {
    expect(layout(60).cell).toBe(18);
  });
});
