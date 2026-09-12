// Grid geometry for the key-map popup, sized to the pane it runs in. The
// four-box bottom row must fit the width, or its lines wrap and the frames
// interleave; boxes shrink to a floor and never grow past the design width.
export const GAP = 3;
export const MARGIN = 3;
const MAX_CELL = 36;
const MIN_CELL = 18;

export interface Layout {
  cell: number; // outer box width
  inner: number; // text width inside "│ ... │"
  grid: number; // four boxes plus gaps
  topIndent: number; // centers the two-box top row over the grid
}

export function layout(columns: number): Layout {
  const fit = Math.floor((columns - MARGIN - 1 - 3 * GAP) / 4);
  const cell = Math.min(MAX_CELL, Math.max(MIN_CELL, fit));
  const grid = 4 * cell + 3 * GAP;
  return {
    cell,
    inner: cell - 4,
    grid,
    topIndent: MARGIN + Math.floor((grid - (2 * cell + GAP)) / 2),
  };
}
