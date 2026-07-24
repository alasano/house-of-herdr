// tapkey <keycode> [tap|down|up|check] [modifier-mask]: posts synthetic key
// events. Modifier mask bits (shared with keys.ts): 1=cmd 2=shift 4=alt
// 8=ctrl, applied as event flags so combos like cmd+shift+p work. Bare
// modifier keycodes (cmd/shift/alt/ctrl, left and right) post flagsChanged
// events carrying the device-specific flag, which apps triggering on a bare
// modifier press listen for. "check" only verifies the Accessibility
// permission. Requires Accessibility to post.
#include <ApplicationServices/ApplicationServices.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// kCGEventFlagMaskNonCoalesced. The SDK documents this bit for mouse and pen
// movement, but the value comes from captures of the vendor app's own key
// synthesis and is what the working hold path posts today, so it stays.
#define FLAG_NON_COALESCED 0x100

#define MODIFIER_MASK_MAX 15
#define KEYCODE_MAX 0xffff
#define TAP_HOLD_US 30000

// kVK_* modifier keycodes with their event flag and NX device-specific bit.
static const struct {
  CGKeyCode code;
  CGEventFlags flag;
  CGEventFlags deviceFlag;
} MODIFIERS[] = {
    {54, kCGEventFlagMaskCommand, 0x10},   // right command
    {55, kCGEventFlagMaskCommand, 0x08},   // left command
    {56, kCGEventFlagMaskShift, 0x02},     // left shift
    {58, kCGEventFlagMaskAlternate, 0x20}, // left option
    {59, kCGEventFlagMaskControl, 0x01},   // left control
    {60, kCGEventFlagMaskShift, 0x04},     // right shift
    {61, kCGEventFlagMaskAlternate, 0x40}, // right option
    {62, kCGEventFlagMaskControl, 0x2000}, // right control
};

static CGEventFlags mask_to_flags(int mask) {
  CGEventFlags flags = 0;
  if (mask & 1) flags |= kCGEventFlagMaskCommand;
  if (mask & 2) flags |= kCGEventFlagMaskShift;
  if (mask & 4) flags |= kCGEventFlagMaskAlternate;
  if (mask & 8) flags |= kCGEventFlagMaskControl;
  return flags;
}

static bool parse_long(const char *text, long min, long max, long *out) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < min || value > max) {
    return false;
  }
  *out = value;
  return true;
}

static bool post(CGKeyCode code, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
  if (event == NULL) {
    fprintf(stderr, "could not create a keyboard event for keycode %u\n", code);
    return false;
  }
  for (size_t i = 0; i < sizeof(MODIFIERS) / sizeof(MODIFIERS[0]); i++) {
    if (MODIFIERS[i].code == code) {
      CGEventSetType(event, kCGEventFlagsChanged);
      CGEventSetFlags(event, down ? MODIFIERS[i].flag | MODIFIERS[i].deviceFlag
                                  : FLAG_NON_COALESCED);
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
      return true;
    }
  }
  // Both edges carry the combo's modifiers. Setting them only on the press
  // left the matching release without them, so an app watching for the end of
  // a held combo saw a different event than the one that started it.
  if (flags != 0) {
    CGEventSetFlags(event, flags | FLAG_NON_COALESCED);
  }
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: tapkey <keycode> [tap|down|up|check] [modifier-mask]\n");
    return 2;
  }
  const char *mode = argc > 2 ? argv[2] : "tap";
  if (!AXIsProcessTrusted()) {
    fprintf(stderr, "accessibility permission not granted\n");
    return 3;
  }
  // Checked before the keycode is parsed: callers pass a dummy keycode.
  if (strcmp(mode, "check") == 0) return 0;

  long keycode = 0;
  if (!parse_long(argv[1], 0, KEYCODE_MAX, &keycode)) {
    fprintf(stderr, "invalid keycode: %s\n", argv[1]);
    return 2;
  }
  long mask = 0;
  if (argc > 3 && !parse_long(argv[3], 0, MODIFIER_MASK_MAX, &mask)) {
    fprintf(stderr, "invalid modifier mask: %s\n", argv[3]);
    return 2;
  }

  CGKeyCode code = (CGKeyCode)keycode;
  CGEventFlags flags = mask_to_flags((int)mask);
  if (strcmp(mode, "down") == 0) {
    if (!post(code, true, flags)) return 4;
  } else if (strcmp(mode, "up") == 0) {
    if (!post(code, false, flags)) return 4;
  } else if (strcmp(mode, "tap") == 0) {
    if (!post(code, true, flags)) return 4;
    usleep(TAP_HOLD_US);
    if (!post(code, false, flags)) return 4;
  } else {
    // Silently tapping on a typo would be worse than refusing.
    fprintf(stderr, "unknown mode: %s\n", mode);
    return 2;
  }
  return 0;
}
