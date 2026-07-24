// Key-combo grammar for `key` bindings: "cmd+shift+p", "f13", "rcmd".
// Names map to macOS virtual keycodes so config authors never see numbers.
// Bare modifier keys (rcmd, lopt, ...) are standalone only: they use the
// flagsChanged path in the tapkey helper that apps triggering on a bare
// modifier press listen for, and they always mirror the physical hold.

export interface KeyCombo {
  keyCode: number;
  /** Modifier bitmask shared with tapkey.c: 1=cmd 2=shift 4=alt 8=ctrl. */
  modifiers: number;
}

// Virtual keycodes of the standalone modifier keys (tapkey.c holds the
// matching flagsChanged table).
const MODIFIER_KEYCODES = new Set([54, 55, 56, 58, 59, 60, 61, 62]);

export function isModifierKey(keyCode: number): boolean {
  return MODIFIER_KEYCODES.has(keyCode);
}

const MODIFIERS: Record<string, number> = {
  cmd: 1,
  command: 1,
  shift: 2,
  alt: 4,
  opt: 4,
  option: 4,
  ctrl: 8,
  control: 8,
};

// macOS virtual keycodes (kVK_*).
const KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  equal: 24,
  "9": 25,
  "7": 26,
  minus: 27,
  "8": 28,
  "0": 29,
  rightbracket: 30,
  o: 31,
  u: 32,
  leftbracket: 33,
  i: 34,
  p: 35,
  return: 36,
  enter: 36,
  l: 37,
  j: 38,
  quote: 39,
  k: 40,
  semicolon: 41,
  backslash: 42,
  comma: 43,
  slash: 44,
  n: 45,
  m: 46,
  period: 47,
  tab: 48,
  space: 49,
  grave: 50,
  backtick: 50,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  rcmd: 54,
  lcmd: 55,
  lshift: 56,
  lopt: 58,
  lalt: 58,
  lctrl: 59,
  rshift: 60,
  ropt: 61,
  ralt: 61,
  rctrl: 62,
  f5: 96,
  f6: 97,
  f7: 98,
  f3: 99,
  f8: 100,
  f9: 101,
  f11: 103,
  f13: 105,
  f16: 106,
  f14: 107,
  f10: 109,
  f12: 111,
  f15: 113,
  home: 115,
  pageup: 116,
  forwarddelete: 117,
  f4: 118,
  end: 119,
  f2: 120,
  pagedown: 121,
  f1: 122,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
};

export function parseKeyCombo(combo: string): KeyCombo {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const keyName = parts.pop();
  if (!keyName) throw new Error(`empty key combo "${combo}"`);
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined)
      throw new Error(`unknown modifier "${part}" in "${combo}"`);
    modifiers |= bit;
  }
  const keyCode = KEY_CODES[keyName];
  if (keyCode === undefined)
    throw new Error(`unknown key "${keyName}" in "${combo}"`);
  if (isModifierKey(keyCode) && modifiers !== 0) {
    throw new Error(
      `"${keyName}" is a bare modifier key and must be used alone, got "${combo}"`,
    );
  }
  return { keyCode, modifiers };
}
