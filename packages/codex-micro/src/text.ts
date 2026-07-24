// Terminal text measurement for the popup's fixed-width boxes. Widths are
// display columns, not code units: a CJK label occupies two columns per
// character, an emoji is one grapheme across two code units, and a combining
// mark adds none. Clipping walks grapheme clusters so it can never split a
// surrogate pair or orphan a combining mark.
import stringWidth from "string-width";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((piece) => piece.segment);
}

// Pane names, tab and workspace labels and working directories are user data
// rendered straight into the terminal. Dropping C0/C1 keeps an embedded
// escape from repositioning the cursor or injecting its own styling, and
// keeps the width measurement honest.
export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)));
}

export function clipEnd(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = "";
  for (const piece of graphemes(text)) {
    if (stringWidth(out + piece) > width - 1) break;
    out += piece;
  }
  return out + "…";
}

export function clipStart(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  const pieces = graphemes(text);
  let out = "";
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (stringWidth(pieces[i]! + out) > width - 1) break;
    out = pieces[i]! + out;
  }
  return "…" + out;
}
