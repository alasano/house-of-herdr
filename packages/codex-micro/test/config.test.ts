import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// config.ts resolves its paths from the environment at import time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-config-"));
process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
process.env.HERDR_PLUGIN_STATE_DIR = dir;

const { CONFIG_FILE, loadConfig, savePolicy } =
  await import("../src/config.js");

const MALFORMED =
  '{ "policy": "mirror", "bindings": { "ACT10": {"key":"rcmd"} } ,}';

function write(text: string): void {
  fs.writeFileSync(CONFIG_FILE, text);
}

beforeEach(() => {
  fs.rmSync(CONFIG_FILE, { force: true });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config exists yet", () => {
    const config = loadConfig();
    expect(config.policy).toBe("sticky");
    expect(config.bindings.buttons.ACT06).toEqual({
      kind: "preset",
      preset: "popup",
    });
  });

  it("reads a valid config", () => {
    write(JSON.stringify({ policy: "mirror", bindings: { ACT10: "zoom" } }));
    const config = loadConfig();
    expect(config.policy).toBe("mirror");
    expect(config.bindings.buttons.ACT10).toEqual({
      kind: "preset",
      preset: "zoom",
    });
  });

  it("reports malformed JSON instead of silently reverting to defaults", () => {
    write(MALFORMED);
    expect(() => loadConfig()).toThrow(/is not valid JSON/);
  });

  it("rejects a non-object root", () => {
    write("[1, 2, 3]");
    expect(() => loadConfig()).toThrow(/expected a JSON object/);
    write("null");
    expect(() => loadConfig()).toThrow(/expected a JSON object/);
  });

  it("rejects an unknown policy rather than coercing it", () => {
    write(JSON.stringify({ policy: "banana" }));
    expect(() => loadConfig()).toThrow(/policy: expected "sticky" or "mirror"/);
  });
});

describe("savePolicy", () => {
  it("preserves fields it does not own", () => {
    write(JSON.stringify({ policy: "sticky", bindings: { ACT10: "zoom" } }));
    savePolicy("mirror");
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as {
      policy: string;
      bindings: Record<string, string>;
    };
    expect(raw.policy).toBe("mirror");
    expect(raw.bindings).toEqual({ ACT10: "zoom" });
  });

  it("writes a fresh config when none exists", () => {
    savePolicy("mirror");
    expect(loadConfig().policy).toBe("mirror");
  });

  it("refuses to overwrite a config it could not parse", () => {
    // The whole point: a trailing comma must not cost the user every binding
    // they have, just because they toggled the policy afterwards.
    write(MALFORMED);
    expect(() => savePolicy("sticky")).toThrow(/is not valid JSON/);
    expect(fs.readFileSync(CONFIG_FILE, "utf8")).toBe(MALFORMED);
  });
});
