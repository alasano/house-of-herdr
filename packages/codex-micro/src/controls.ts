// Device input dispatch: Agent Keys focus their slotted agents (hardwired);
// every other input runs its configured binding. Presets call Herdr's socket
// API; `key` bindings mirror physical press/release as synthetic macOS
// keystrokes; `herdr-key`/`herdr-text` inject into Herdr's focused pane;
// `exec` spawns a command on press.
import { spawn } from "node:child_process";
import { postKey, type KeyMode } from "./tapkey.js";
import type {
  Binding,
  Bindings,
  ButtonInput,
  JoystickDirection,
  Preset,
} from "./bindings.js";
import type { KeyCombo } from "./keys.js";
import { comparePriority } from "./slots.js";
import type { AgentInfo, HerdrClient } from "./herdr.js";

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

// Wraps in both directions. Returns undefined only for an empty list.
function cycle<T>(items: T[], current: number, step: 1 | -1): T | undefined {
  if (items.length === 0) return undefined;
  return items[(current + step + items.length) % items.length];
}

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
  // What each physical input is holding, recorded at press time. Release
  // resolves through this, never through the current binding: a config
  // reload between the two edges would otherwise orphan the down edge and
  // strand a modifier down system-wide.
  private heldByInput = new Map<string, KeyCombo>();
  // Refcount per combo, so two inputs holding the same key post one down on
  // the first and one up on the last, rather than releasing on the first.
  private holds = new Map<string, { combo: KeyCombo; count: number }>();
  dialMode: DialMode = "workspaces";

  constructor(
    private herdr: HerdrClient,
    private deps: ControlDeps,
    private log: (message: string) => void,
  ) {}

  // The HID callbacks run straight off the device stream, so a synchronous
  // throw here would take the daemon down with it.
  onHid(key: string, act: number): void {
    try {
      this.dispatchHid(key, act);
    } catch (error) {
      this.log(`input ${key} failed: ${(error as Error).message}`);
    }
  }

  onJoystick(angle: number, distance: number): void {
    try {
      this.dispatchJoystick(angle, distance);
    } catch (error) {
      this.log(`joystick input failed: ${(error as Error).message}`);
    }
  }

  // A synthetic key must never stay logically held when the device
  // disappears or the daemon exits mid-hold, and a stick that vanishes while
  // deflected must not suppress the next deflection into the same sector.
  resetInputState(): void {
    for (const { combo } of this.holds.values()) this.tapKey(combo, "up");
    this.holds.clear();
    this.heldByInput.clear();
    this.lastSector = null;
  }

  private dispatchHid(key: string, act: number): void {
    const agentKey = /^AG0([0-5])$/.exec(key);
    if (agentKey) {
      if (act === 1) this.focusSlot(Number(agentKey[1]));
      return;
    }
    if (act === 0) {
      this.endHold(key);
      return;
    }
    const binding = this.deps.bindings().buttons[key as ButtonInput];
    if (!binding) return;
    if (key === "ENC_CW" || key === "ENC_CC") {
      if (act === 2) this.dispatchDialTick(binding);
      return;
    }
    if (act === 1) this.dispatchPress(key, binding);
  }

  private dispatchJoystick(angle: number, distance: number): void {
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

  private beginHold(input: string, combo: KeyCombo): void {
    if (this.heldByInput.has(input)) return; // repeat press without a release
    this.heldByInput.set(input, combo);
    const id = comboId(combo);
    const entry = this.holds.get(id);
    if (entry) {
      entry.count += 1;
      return;
    }
    this.holds.set(id, { combo, count: 1 });
    this.tapKey(combo, "down");
  }

  private endHold(input: string): void {
    const combo = this.heldByInput.get(input);
    if (!combo) return;
    this.heldByInput.delete(input);
    const id = comboId(combo);
    const entry = this.holds.get(id);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    this.holds.delete(id);
    this.tapKey(combo, "up");
  }

  private dispatchPress(input: string, binding: Binding): void {
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
        if (binding.hold) this.beginHold(input, binding.combo);
        else this.tapKey(binding.combo, "tap");
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

  // Dial ticks and joystick sectors have no release edge, so hold bindings
  // are rejected at parse time and every key binding here taps.
  private dispatchTap(binding: Binding): void {
    if (binding.kind === "key") this.tapKey(binding.combo, "tap");
    else this.dispatchPress("", binding);
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
      default: {
        // Adding a preset without handling it here is a compile error.
        const unhandled: never = preset;
        throw new Error(`unhandled preset: ${String(unhandled)}`);
      }
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
      const next = cycle(workspaces, current, step);
      if (next) {
        await this.herdr.request("workspace.focus", {
          workspace_id: next.workspace_id,
        });
      }
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
      // Resolve the current tab from the tab snapshot's own focus flag: the
      // workspace record came from an earlier request and its active_tab_id
      // can already be stale, which would drag focus back to a workspace the
      // user just left.
      const current = tabs.findIndex((tab) => tab.focused);
      if (current === -1 || tabs.length < 2) return;
      const next = cycle(tabs, current, step);
      if (next) await this.herdr.request("tab.focus", { tab_id: next.tab_id });
    } catch (error) {
      this.log(`tab step failed: ${(error as Error).message}`);
    }
  }

  // Cycles all agents in Herdr's attention priority order, not just the six
  // slotted ones.
  private async stepAgent(step: 1 | -1): Promise<void> {
    try {
      const agents = await this.herdr.agentList();
      if (agents.length === 0) return;
      const sorted = [...agents]
        .map((agent) => ({
          agent,
          status: agent.agent_status,
          seq: agent.state_change_seq,
        }))
        .sort(comparePriority)
        .map((entry) => entry.agent);
      const current = sorted.findIndex((agent) => agent.focused);
      // The focused pane is often not an agent at all, so an unfocused list
      // still has somewhere to go: start at the neediest.
      const next: AgentInfo | undefined =
        current === -1 ? sorted[0] : cycle(sorted, current, step);
      if (next)
        await this.herdr.request("agent.focus", { target: next.pane_id });
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

  private tapKey(combo: KeyCombo, mode: KeyMode): void {
    postKey(combo, mode, this.log);
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
