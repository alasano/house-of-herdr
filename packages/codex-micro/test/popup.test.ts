import { describe, expect, it } from "vitest";
import { renderPopup } from "../src/popup-render.js";
import { displayWidth } from "../src/text.js";
import type { StatusPayload } from "../src/control.js";

function status(): StatusPayload {
  return {
    policy: "sticky",
    scrollSteps: 1,
    dialMode: "scroll",
    dialModeOrder: ["workspaces", "agents", "scroll"],
    state: "connected",
    herdrConnected: true,
    configError: null,
    slots: Array.from({ length: 6 }, (_, index) => ({
      key: index + 1,
      paneId: `wA:p${index + 1}`,
      agent: "pi",
      paneName: "Long 漢字 name 👩‍💻 ".repeat(10),
      workspace: "workspace".repeat(30),
      tab: "tab".repeat(30),
      cwd: "/some/very/long/directory/".repeat(20),
      status: "working" as const,
    })),
  };
}

describe("popup layout", () => {
  it.each([
    [160, 22],
    [81, 22],
    [95, 22],
    [65, 22],
    [64, 22],
    [40, 12],
    [20, 10],
    [5, 3],
    [1, 1],
  ])(
    "fits %i columns by %i rows without wrapping or scrolling",
    (columns, rows) => {
      const lines = renderPopup(status(), true, columns, rows);
      expect(lines.length).toBeLessThanOrEqual(rows - 1);
      for (const line of lines)
        expect(displayWidth(line)).toBeLessThanOrEqual(columns - 1);
    },
  );

  it("shows all six numbered boxes at the observed narrow pane width", () => {
    const rendered = renderPopup(status(), true, 81, 22).join("\n");
    for (let key = 1; key <= 6; key++) expect(rendered).toContain(`[${key}]`);
    expect(rendered).toContain("┌");
    expect(rendered).toContain("q / esc close");
  });

  it("uses a compact list when the box grid cannot fit", () => {
    const rendered = renderPopup(status(), true, 40, 12).join("\n");
    expect(rendered).not.toContain("┌");
    for (let key = 1; key <= 6; key++) expect(rendered).toContain(`[${key}]`);
    expect(rendered).toContain("q / esc close");
  });

  it("renders empty slots and disconnected/error states within bounds", () => {
    const payload = {
      ...status(),
      slots: Array(6).fill(null),
      configError: "bad config".repeat(100),
      herdrConnected: false,
    };
    const lines = renderPopup(payload, false, 81, 22);
    for (const line of lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(lines.join("\n")).toContain("daemon disconnected");
    expect(lines.join("\n")).toContain("config error:");
    expect(lines.join("\n")).toContain("empty");
  });

  it("clips initial connection text and strips user control sequences", () => {
    expect(
      renderPopup(null, true, 10, 10).every((line) => displayWidth(line) <= 9),
    ).toBe(true);
    const payload = status();
    payload.slots[0]!.paneName = "injected\x1b[2J\r\nname";
    const rendered = renderPopup(payload, true, 81, 22).join("\n");
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).not.toContain("\r");
  });
});
