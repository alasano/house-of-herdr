import { describe, expect, it } from "vitest";
import {
  clipEnd,
  clipStart,
  displayWidth,
  padTo,
  sanitize,
} from "../src/text.js";

// The popup draws fixed-width boxes, so every field must be measured and cut
// in display columns. These cases are all real user data: pane names, tab and
// workspace labels, and working directories.
describe("display width", () => {
  it("pads to a column count, not a code-unit count", () => {
    expect(displayWidth(padTo("abc", 10))).toBe(10);
    expect(displayWidth(padTo("漢字", 10))).toBe(10); // 2 columns each
    expect(displayWidth(padTo("😀😀", 10))).toBe(10);
    expect(displayWidth(padTo("éé", 10))).toBe(10); // combining marks
  });

  it("never pads past the target for already-wide text", () => {
    expect(padTo("漢".repeat(8), 10)).toBe("漢".repeat(8));
  });
});

describe("clipEnd", () => {
  it("leaves text that already fits", () => {
    expect(clipEnd("short", 10)).toBe("short");
  });

  it("clips wide characters by column, keeping the result within the box", () => {
    const clipped = clipEnd("漢".repeat(20), 10);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(10);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const clipped = clipEnd("😀".repeat(20), 11);
    expect(clipped).not.toContain("�");
    expect(displayWidth(clipped)).toBeLessThanOrEqual(11);
  });

  it("keeps combining marks attached to their base character", () => {
    const clipped = clipEnd("é".repeat(20), 10);
    expect(clipped).not.toContain("�");
    expect(displayWidth(clipped)).toBeLessThanOrEqual(10);
  });
});

describe("clipStart", () => {
  it("keeps the tail of a long path", () => {
    const clipped = clipStart("/Users/a/very/long/path/to/the/end", 12);
    expect(clipped.startsWith("…")).toBe(true);
    expect(clipped.endsWith("end")).toBe(true);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(12);
  });

  it("clips wide paths by column without splitting graphemes", () => {
    const clipped = clipStart("/Users/a/專案/模型/資料夾/末尾", 12);
    expect(clipped).not.toContain("�");
    expect(displayWidth(clipped)).toBeLessThanOrEqual(12);
  });
});

describe("sanitize", () => {
  it("strips control characters that would move the cursor or inject color", () => {
    expect(sanitize("a\x1b[31mred\x1b[0m")).toBe("a[31mred[0m");
    expect(sanitize("line\nbreak\ttab")).toBe("linebreaktab");
    expect(sanitize("bell\x07")).toBe("bell");
    expect(sanitize("c1\x9b")).toBe("c1");
  });

  it("leaves ordinary text, including wide and combining characters", () => {
    expect(sanitize("pane 漢字 é 😀")).toBe("pane 漢字 é 😀");
  });
});
