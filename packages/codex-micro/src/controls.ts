// Device input dispatch: Agent Keys focus their slotted agents (hardwired);
// every other input runs its configured binding. Presets call Herdr's socket
// API; `key` bindings mirror physical press/release as synthetic macOS
// keystrokes; `herdr-key`/`herdr-text` inject into Herdr's focused pane;
// `exec` spawns a command on press.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  Binding,
  Bindings,
  ButtonInput,
  JoystickDirection,
  Preset,
} from "./bindings.js";
import type { KeyCombo } from "./keys.js";
import { attention } from "./slots.js";
import type { HerdrClient } from "./herdr.js";

const DIAL_PRESET_MIN_INTERVAL_MS = 120;
// Sweep model: the first sector entered past ENGAGE fires, and every sector
// change while the stick stays deflected (above RELEASE) fires again, so
// circling the stick walks focus around without re-centering. Returning to
// center resets tracking.
const ENGAGE_DISTANCE = 0.75;
const RELEASE_DISTANCE = 0.3;
// Angle is a 0..1 turn clockwise from east; sector centers at 0, 0.25, 0.5,
// 0.75. No dead wedges: every deflection resolves to the nearest direction.
const SECTOR_DIRECTIONS: JoystickDirection[] = ["right", "down", "left", "up"];

export type DialMode = "workspaces" | "agents";

const comboId = (combo: KeyCombo) => `${combo.keyCode}:${combo.modifiers}`;

export interface ControlDeps {
  bindings(): Bindings;
  slotPaneId(slot: number): string | null;
  togglePopup(): void;
  togglePolicy(): void;
  onDialModeChange(mode: DialMode): void;
}

export class Controls {
  private lastDialPresetAt = 0;
  private lastSector: number | null = null;
  private heldCombos = new Map<string, KeyCombo>();
  dialMode: DialMode = "workspaces";

  constructor(
    private herdr: HerdrClient,
    private deps: ControlDeps,
    private log: (message: string) => void,
  ) {}

  onHid(key: string, act: number): void {
    const agentKey = /^AG0([0-5])$/.exec(key);
    if (agentKey) {
      if (act === 1) this.focusSlot(Number(agentKey[1]));
      return;
    }
    const binding = this.deps.bindings().buttons[key as ButtonInput];
    if (!binding) return;
    if (key === "ENC_CW" || key === "ENC_CC") {
      if (act === 2) this.dispatchDialTick(binding);
      return;
    }
    if (act === 1) this.dispatchPress(binding);
    else if (act === 0) this.dispatchRelease(binding);
  }

  onJoystick(angle: number, distance: number): void {
    if (distance <= RELEASE_DISTANCE) {
      this.lastSector = null;
      return;
    }
    if (this.lastSector === null && distance < ENGAGE_DISTANCE) return;
    const sector =
      Math.round(angle * SECTOR_DIRECTIONS.length) % SECTOR_DIRECTIONS.length;
    if (sector === this.lastSector) return;
    this.lastSector = sector;
    const direction = SECTOR_DIRECTIONS[sector]!;
    const binding = this.deps.bindings().joystick[direction];
    if (binding === null) {
      this.run("pane.focus_direction", { direction });
    } else {
      this.dispatchTap(binding);
    }
  }

  // A synthetic key must never stay logically held when the device
  // disappears or the daemon exits mid-hold.
  releaseHeldKeys(): void {
    for (const combo of this.heldCombos.values()) {
      this.tapKey(combo, "up");
    }
    this.heldCombos.clear();
  }

  private dispatchPress(binding: Binding): void {
    switch (binding.kind) {
      case "preset":
        this.runPreset(binding.preset);
        break;
      case "key":
        // Hold bindings (bare modifiers, and combos with "hold": true)
        // mirror physical edges; the rest tap in one helper process. Split
        // down/up processes are not delivered as a keypress by some apps
        // (observed in VS Code), and synthetic holds cannot autorepeat, so
        // mirroring buys nothing for typing keys.
        if (binding.hold) {
          this.heldCombos.set(comboId(binding.combo), binding.combo);
          this.tapKey(binding.combo, "down");
        } else {
          this.tapKey(binding.combo, "tap");
        }
        break;
      case "herdr-key":
        void this.sendToFocusedPane("pane.send_keys", { keys: [binding.keys] });
        break;
      case "herdr-text":
        void this.sendToFocusedPane("pane.send_text", { text: binding.text });
        break;
      case "exec":
        this.execCommand(binding.argv);
        break;
      case "none":
        break;
    }
  }

  private dispatchRelease(binding: Binding): void {
    if (binding.kind !== "key" || !binding.hold) return;
    this.heldCombos.delete(comboId(binding.combo));
    this.tapKey(binding.combo, "up");
  }

  // Joystick sectors have no meaningful release edge; key bindings tap.
  private dispatchTap(binding: Binding): void {
    if (binding.kind === "key") this.tapKey(binding.combo, "tap");
    else this.dispatchPress(binding);
  }

  // Presets on the dial are rate-limited so a fast spin does not queue a
  // dozen navigation calls; raw key/exec bindings fire per tick.
  private dispatchDialTick(binding: Binding): void {
    if (binding.kind === "preset") {
      const now = Date.now();
      if (now - this.lastDialPresetAt < DIAL_PRESET_MIN_INTERVAL_MS) return;
      this.lastDialPresetAt = now;
      this.runPreset(binding.preset);
    } else {
      this.dispatchTap(binding);
    }
  }

  private runPreset(preset: Preset): void {
    switch (preset) {
      case "popup":
        this.deps.togglePopup();
        break;
      case "zoom":
        this.run("pane.zoom", {});
        break;
      case "tab-next":
        void this.stepTab(1);
        break;
      case "tab-prev":
        void this.stepTab(-1);
        break;
      case "tab-new":
        this.run("tab.create", { focus: true });
        break;
      case "workspace-next":
        void this.stepWorkspace(1);
        break;
      case "workspace-prev":
        void this.stepWorkspace(-1);
        break;
      case "pane-split-right":
        this.run("pane.split", { direction: "right", focus: true });
        break;
      case "pane-split-down":
        this.run("pane.split", { direction: "down", focus: true });
        break;
      case "agent-next":
        void this.stepAgent(1);
        break;
      case "agent-prev":
        void this.stepAgent(-1);
        break;
      case "toggle-policy":
        this.deps.togglePolicy();
        break;
      case "dial-next":
        if (this.dialMode === "workspaces") void this.stepWorkspace(1);
        else void this.stepAgent(1);
        break;
      case "dial-prev":
        if (this.dialMode === "workspaces") void this.stepWorkspace(-1);
        else void this.stepAgent(-1);
        break;
      case "dial-mode":
        this.dialMode =
          this.dialMode === "workspaces" ? "agents" : "workspaces";
        this.deps.onDialModeChange(this.dialMode);
        break;
    }
  }

  private focusSlot(slot: number): void {
    const paneId = this.deps.slotPaneId(slot);
    if (!paneId) return;
    this.run("agent.focus", { target: paneId });
  }

  private async stepWorkspace(step: 1 | -1): Promise<void> {
    try {
      const workspaces = await this.herdr.workspaceList();
      const current = workspaces.findIndex((workspace) => workspace.focused);
      if (current === -1 || workspaces.length < 2) return;
      const next =
        workspaces[(current + step + workspaces.length) % workspaces.length];
      await this.herdr.request("workspace.focus", {
        workspace_id: next!.workspace_id,
      });
    } catch (error) {
      this.log(`workspace step failed: ${(error as Error).message}`);
    }
  }

  private async stepTab(step: 1 | -1): Promise<void> {
    try {
      const workspaces = await this.herdr.workspaceList();
      const focused = workspaces.find((workspace) => workspace.focused);
      if (!focused) return;
      const tabs = await this.herdr.tabList(focused.workspace_id);
      const current = tabs.findIndex(
        (tab) => tab.tab_id === focused.active_tab_id,
      );
      if (current === -1 || tabs.length < 2) return;
      const next = tabs[(current + step + tabs.length) % tabs.length];
      await this.herdr.request("tab.focus", { tab_id: next!.tab_id });
    } catch (error) {
      this.log(`tab step failed: ${(error as Error).message}`);
    }
  }

  // Cycles all agents in the sidebar's priority order (attention, then most
  // recent state change), not just the six slotted ones.
  private async stepAgent(step: 1 | -1): Promise<void> {
    try {
      const agents = await this.herdr.agentList();
      if (agents.length === 0) return;
      const sorted = [...agents].sort(
        (a, b) =>
          attention(b.agent_status) - attention(a.agent_status) ||
          b.state_change_seq - a.state_change_seq,
      );
      const current = sorted.findIndex((agent) => agent.focused);
      const next =
        current === -1
          ? sorted[0]
          : sorted[(current + step + sorted.length) % sorted.length];
      await this.herdr.request("agent.focus", { target: next!.pane_id });
    } catch (error) {
      this.log(`agent step failed: ${(error as Error).message}`);
    }
  }

  private async sendToFocusedPane(
    method: "pane.send_keys" | "pane.send_text",
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const current = await this.herdr.request("pane.current", {});
      const pane = current.pane as { pane_id?: string } | undefined;
      if (!pane?.pane_id) return;
      await this.herdr.request(method, { pane_id: pane.pane_id, ...params });
    } catch (error) {
      this.log(`${method} failed: ${(error as Error).message}`);
    }
  }

  // Posts a synthetic keystroke via the compiled tapkey helper; requires the
  // Accessibility permission for the daemon's process tree.
  private tapKey(combo: KeyCombo, mode: "tap" | "down" | "up"): void {
    const helper = fileURLToPath(new URL("../bin/tapkey", import.meta.url));
    const args = [String(combo.keyCode), mode, String(combo.modifiers)];
    const child = spawn(helper, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on(
      "data",
      (data: Buffer) => (stderr += data.toString("utf8")),
    );
    child.on("close", (status) => {
      if (status !== 0)
        this.log(`key ${combo.keyCode} ${mode} failed: ${stderr.trim()}`);
    });
    child.on("error", (error: Error) =>
      this.log(`tapkey spawn failed: ${error.message}`),
    );
  }

  private execCommand(argv: string[]): void {
    const [command, ...args] = argv;
    const child = spawn(command!, args, { stdio: "ignore", detached: true });
    child.on("error", (error: Error) =>
      this.log(`exec ${command} failed: ${error.message}`),
    );
    child.unref();
  }

  private run(method: string, params: unknown): void {
    this.herdr.request(method, params).catch((error: Error) => {
      this.log(`${method} failed: ${error.message}`);
    });
  }
}
