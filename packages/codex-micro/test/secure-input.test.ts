import { describe, expect, it } from "vitest";
import {
  describeSecureInput,
  holderName,
  parseSecureInputPid,
} from "../src/secure-input.js";

const CONSOLE_USERS = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 29>
  {
    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="marcel","kCGSSessionSecureInputPID"=646,"kCGSSessionUserIDKey"=501})
  }`;

describe("parseSecureInputPid", () => {
  it("reads the holding pid from the console session", () => {
    expect(parseSecureInputPid(CONSOLE_USERS)).toBe(646);
  });

  it("reports no holder when the key is absent", () => {
    const off = CONSOLE_USERS.replace(',"kCGSSessionSecureInputPID"=646', "");
    expect(parseSecureInputPid(off)).toBeNull();
  });
});

describe("holderName", () => {
  it("names the app bundle rather than its binary", () => {
    expect(holderName("/Applications/Zen.app/Contents/MacOS/zen\n")).toBe(
      "Zen",
    );
    expect(
      holderName("/Applications/1Password.app/Contents/MacOS/1Password"),
    ).toBe("1Password");
  });

  it("falls back to the command name outside a bundle", () => {
    expect(holderName("/usr/bin/login")).toBe("login");
  });

  it("is null for a process that has exited", () => {
    expect(holderName("")).toBeNull();
  });
});

describe("describeSecureInput", () => {
  it("names a live holder", () => {
    expect(describeSecureInput({ pid: 646, name: "Zen" })).toContain(
      "held by Zen (pid 646)",
    );
  });

  it("points past a holder that has exited", () => {
    expect(describeSecureInput({ pid: 646, name: null })).toContain(
      "another app still holds it",
    );
  });
});
