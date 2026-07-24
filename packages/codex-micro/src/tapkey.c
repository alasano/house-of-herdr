// tapkey <keycode> [tap|down|up|check] [modifier-mask]: posts synthetic key
// events. Modifier mask bits (shared with keys.ts): 1=cmd 2=shift 4=alt
// 8=ctrl, applied as event flags so combos like cmd+shift+p work. Bare
// modifier keycodes (cmd/shift/alt/ctrl, left and right) post flagsChanged
// events carrying the device-specific flag, which apps triggering on a bare
// modifier press listen for. "check" only verifies the Accessibility
// permission. Requires Accessibility to post.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define FLAG_NON_COALESCED 0x100

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

static void post(CGKeyCode code, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
  for (size_t i = 0; i < sizeof(MODIFIERS) / sizeof(MODIFIERS[0]); i++) {
    if (MODIFIERS[i].code == code) {
      CGEventSetType(event, kCGEventFlagsChanged);
      CGEventSetFlags(event, down ? MODIFIERS[i].flag | MODIFIERS[i].deviceFlag
                                  : FLAG_NON_COALESCED);
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
      return;
    }
  }
  if (down && flags != 0) {
    CGEventSetFlags(event, flags | FLAG_NON_COALESCED);
  }
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  const char *mode = argc > 2 ? argv[2] : "tap";
  if (!AXIsProcessTrusted()) {
    fprintf(stderr, "accessibility permission not granted\n");
    return 3;
  }
  if (strcmp(mode, "check") == 0) return 0;
  CGKeyCode code = (CGKeyCode)atoi(argv[1]);
  CGEventFlags flags = mask_to_flags(argc > 3 ? atoi(argv[3]) : 0);
  if (strcmp(mode, "down") == 0) {
    post(code, true, flags);
  } else if (strcmp(mode, "up") == 0) {
    post(code, false, flags);
  } else {
    post(code, true, flags);
    usleep(30000);
    post(code, false, flags);
  }
  return 0;
}
