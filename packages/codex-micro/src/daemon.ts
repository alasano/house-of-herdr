// The Codex Micro broker daemon: owns the HID connection, mirrors Herdr agent
// state onto the six Agent Key LEDs, and routes device input back into Herdr.
// Session-leased: if Herdr stays unreachable beyond the lease, the daemon
// clears the LEDs, releases the device, and exits.
import { spawn } from "node:child_process";
import { CodexMicro } from "./device.js";
import {
  HerdrClient,
  subscribe,
  type AgentInfo,
  type PaneInfo,
  type Subscription,
} from "./herdr.js";
import fs from "node:fs";
import { Controls, type DialMode } from "./controls.js";
import { ControlServer, type SlotStatus } from "./control.js";
import { slotLighting } from "./lights.js";
import {
  assignSlots,
  SLOT_COUNT,
  type AgentStatus,
  type Policy,
} from "./slots.js";
import { defaultBindings, type Bindings } from "./bindings.js";
import {
  CONFIG_DIR,
  ensureStateDir,
  loadConfig,
  savePolicy,
  PLUGIN_ID,
} from "./config.js";

const REFRESH_DEBOUNCE_MS = 75;
const HERDR_RETRY_MS = 3000;
const HERDR_LEASE_MS = 60_000;
// The ChatGPT desktop app cannot share the device: opened first it seizes
// exclusively, opened second both hosts receive every input (double
// dispatch). The daemon therefore yields whenever the app is running.
const CHATGPT_BINARY = "ChatGPT.app/Contents/MacOS/ChatGPT";
const CHATGPT_POLL_MS = 4000;
const CONFIG_RELOAD_DEBOUNCE_MS = 300;
const KEY_GLYPHS = ["①", "②", "③", "④", "⑤", "⑥"];
// The ambient ring doubles as the dial-mode indicator: blue in agent mode.
const RING_AGENTS = { e: 1, b: 0.5, s: 0, m: 0, c: 0x2277ff };
const RING_OFF = { e: 0, b: 0, s: 0, m: 0, c: 0 };

const BASE_SUBSCRIPTIONS: Subscription[] = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
];

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function shortenHome(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

class Daemon {
  private herdr = new HerdrClient();
  private policy: Policy = "sticky";
  private bindings: Bindings = defaultBindings();
  private configError: string | null = null;
  private configWatcher: fs.FSWatcher | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private slots: (string | null)[] = Array.from(
    { length: SLOT_COUNT },
    () => null,
  );
  private slotDetails: (SlotStatus | null)[] = Array.from(
    { length: SLOT_COUNT },
    () => null,
  );
  private agents = new Map<string, AgentInfo>();
  private tokenPanes = new Map<string, string>();
  private lastLighting = "";
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private refreshDirty = false;
  private subGeneration = 0;
  private closeSubscription: (() => void) | null = null;
  private subRetryTimer: NodeJS.Timeout | null = null;
  private subscribedPanes = "";
  private herdrLostAt: number | null = null;
  private yielded = false;
  private chatGptTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  private device = new CodexMicro(
    {
      onConnect: () => {
        this.lastLighting = "";
        void this.pushLighting();
        this.pushRing();
      },
      onDisconnect: () => this.controls.releaseHeldKeys(),
      onStateChange: () => this.control.broadcast(),
      onHid: (key, act) => this.controls.onHid(key, act),
      onJoystick: (angle, distance) =>
        this.controls.onJoystick(angle, distance),
    },
    log,
  );

  private controls = new Controls(
    this.herdr,
    {
      bindings: () => this.bindings,
      slotPaneId: (slot) => {
        const terminalId = this.slots[slot] ?? null;
        return terminalId
          ? (this.agents.get(terminalId)?.pane_id ?? null)
          : null;
      },
      togglePopup: () => void this.togglePopup(),
      togglePolicy: () => this.togglePolicy(),
      onDialModeChange: (mode) => this.onDialModeChange(mode),
    },
    log,
  );

  private control = new ControlServer({
    status: () => ({
      policy: this.policy,
      dialMode: this.controls.dialMode,
      state: this.yielded ? "yielded" : this.device.state,
      herdrConnected: this.herdrLostAt === null,
      configError: this.configError,
      slots: this.slotDetails,
    }),
    togglePolicy: () => this.togglePolicy(),
    popup: () => void this.togglePopup(),
    stop: () => void this.shutdown(),
  });

  async start(): Promise<void> {
    ensureStateDir();
    await this.control.listen();
    this.applyConfig(true);
    this.watchConfig();
    log(`daemon started, policy: ${this.policy}`);
    process.on("SIGTERM", () => void this.shutdown());
    process.on("SIGINT", () => void this.shutdown());
    this.device.start();
    this.maintainSubscription();
    this.chatGptTimer = setInterval(
      () => void this.pollChatGpt(),
      CHATGPT_POLL_MS,
    );
  }

  // Invalid config never kills the daemon: it keeps the last good (or
  // default) state and surfaces the validation error through status, which
  // is the feedback loop a config-editing agent reads.
  private applyConfig(initial = false): void {
    try {
      const config = loadConfig();
      const policyChanged = config.policy !== this.policy;
      this.policy = config.policy;
      this.bindings = config.bindings;
      this.configError = null;
      // A mode nothing can toggle anymore must not linger: without any
      // dial-mode binding, collapse back to workspace mode (ring off).
      const hasDialMode = [
        ...Object.values(this.bindings.buttons),
        ...Object.values(this.bindings.joystick),
      ].some(
        (binding) =>
          binding?.kind === "preset" && binding.preset === "dial-mode",
      );
      if (!hasDialMode && this.controls.dialMode === "agents") {
        this.controls.dialMode = "workspaces";
        this.pushRing();
      }
      if (!initial) {
        log(`config applied, policy: ${this.policy}`);
        if (policyChanged) this.scheduleRefresh();
      }
    } catch (error) {
      this.configError = (error as Error).message;
      log(`config invalid, keeping previous: ${this.configError}`);
    }
    this.control.broadcast();
  }

  // Watches the config dir (not the file: atomic tmp+rename writes replace
  // the inode) and hot-applies changes; no restart needed for config edits.
  private watchConfig(): void {
    try {
      this.configWatcher = fs.watch(CONFIG_DIR, () => {
        if (this.configReloadTimer) return;
        this.configReloadTimer = setTimeout(() => {
          this.configReloadTimer = null;
          this.applyConfig();
        }, CONFIG_RELOAD_DEBOUNCE_MS);
      });
    } catch (error) {
      log(`config watch unavailable: ${(error as Error).message}`);
    }
  }

  private togglePolicy(): Policy {
    const next: Policy = this.policy === "sticky" ? "mirror" : "sticky";
    savePolicy(next); // the file watcher applies and broadcasts it
    this.policy = next;
    log(`policy: ${this.policy}`);
    this.scheduleRefresh();
    return this.policy;
  }

  private onDialModeChange(mode: DialMode): void {
    log(`dial mode: ${mode}`);
    this.herdr
      .request("notification.show", { title: `dial → ${mode}` })
      .catch(() => {});
    this.pushRing();
    this.control.broadcast();
  }

  private pushRing(): void {
    if (!this.device.connected) return;
    this.device
      .setAmbientLighting(
        this.controls.dialMode === "agents" ? RING_AGENTS : RING_OFF,
      )
      .catch((error: Error) => log(`ring update failed: ${error.message}`));
  }

  private async pollChatGpt(): Promise<void> {
    if (this.stopping) return;
    const running = await new Promise<boolean>((resolve) => {
      const child = spawn("pgrep", ["-f", CHATGPT_BINARY], { stdio: "ignore" });
      child.on("close", (status) => resolve(status === 0));
      child.on("error", () => resolve(false));
    });
    if (running === this.yielded) return;
    this.yielded = running;
    if (running) {
      log("ChatGPT app detected, yielding the device");
      this.controls.releaseHeldKeys();
      if (this.device.connected) {
        await this.device
          .setThreadLighting(
            slotLighting(Array.from({ length: SLOT_COUNT }, () => null)),
          )
          .catch(() => {});
        await this.device.setAmbientLighting(RING_OFF).catch(() => {});
      }
      await this.device.stop();
    } else {
      log("ChatGPT app gone, reclaiming the device");
      this.device.start();
    }
    this.control.broadcast();
  }

  // Keeps one events connection alive, rebuilt whenever the agent pane set
  // changes (per-pane status subscriptions cannot be added incrementally).
  // Generation tags distinguish intentional closes from failures.
  private maintainSubscription(): void {
    if (this.stopping) return;
    const generation = ++this.subGeneration;
    void (async () => {
      try {
        await this.runRefresh();
        if (this.stopping || generation !== this.subGeneration) return;
        const panes = [...this.agents.values()]
          .map((agent) => agent.pane_id)
          .sort();
        const subscriptions = [
          ...BASE_SUBSCRIPTIONS,
          ...panes.map((paneId) => ({
            type: "pane.agent_status_changed",
            pane_id: paneId,
          })),
        ];
        const close = await subscribe(
          subscriptions,
          () => this.scheduleRefresh(),
          () => this.onSubscriptionLost(generation, "events connection closed"),
        );
        if (this.stopping || generation !== this.subGeneration) {
          close();
          return;
        }
        this.closeSubscription = close;
        this.subscribedPanes = panes.join(",");
        this.herdrLostAt = null;
        log(`subscribed to ${panes.length} agent panes`);
        // Reconcile anything that changed between the snapshot and the ack.
        this.scheduleRefresh();
      } catch (error) {
        this.onSubscriptionLost(generation, (error as Error).message);
      }
    })();
  }

  private onSubscriptionLost(generation: number, reason: string): void {
    if (this.stopping || generation !== this.subGeneration) return;
    this.closeSubscription = null;
    this.herdrLostAt ??= Date.now();
    if (Date.now() - this.herdrLostAt > HERDR_LEASE_MS) {
      log("herdr unreachable beyond lease, releasing device and exiting");
      void this.shutdown();
      return;
    }
    log(`resubscribing in ${HERDR_RETRY_MS}ms: ${reason}`);
    this.subRetryTimer = setTimeout(
      () => this.maintainSubscription(),
      HERDR_RETRY_MS,
    );
  }

  private rebuildSubscription(): void {
    this.subGeneration++; // invalidates the old connection's onClose
    this.closeSubscription?.();
    this.closeSubscription = null;
    this.maintainSubscription();
  }

  private scheduleRefresh(): void {
    if (this.stopping || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.runRefresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  // Single-flight: one refresh at a time; requests arriving mid-flight
  // coalesce into exactly one follow-up run.
  private async runRefresh(): Promise<void> {
    if (this.stopping) return;
    if (this.refreshing) {
      this.refreshDirty = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.refresh();
    } catch (error) {
      log(`refresh failed: ${(error as Error).message}`);
    } finally {
      this.refreshing = false;
      if (this.refreshDirty && !this.stopping) {
        this.refreshDirty = false;
        void this.runRefresh();
      }
    }
  }

  private async refresh(): Promise<void> {
    const list = await this.herdr.agentList();
    this.agents = new Map(list.map((agent) => [agent.terminal_id, agent]));
    this.slots = assignSlots(
      this.slots,
      list.map((agent) => ({
        terminalId: agent.terminal_id,
        status: agent.agent_status,
        seq: agent.state_change_seq,
      })),
      this.policy,
    );
    await this.updateSlotDetails();
    await this.updateKeyTokens();
    await this.pushLighting();
    this.control.broadcast();

    const panes = [...this.agents.values()]
      .map((agent) => agent.pane_id)
      .sort()
      .join(",");
    if (this.closeSubscription && panes !== this.subscribedPanes) {
      this.rebuildSubscription();
    }
  }

  // Resolves the display facts the popup shows per slot: pane name, workspace
  // and tab labels, and the pane's live working directory.
  private async updateSlotDetails(): Promise<void> {
    const slotted = this.slots
      .map((terminalId) =>
        terminalId ? this.agents.get(terminalId) : undefined,
      )
      .filter((agent): agent is AgentInfo => agent !== undefined);
    let workspaceLabels = new Map<string, string>();
    let tabLabels = new Map<string, string>();
    let panes = new Map<string, PaneInfo>();
    if (slotted.length > 0) {
      try {
        const workspaceIds = [
          ...new Set(slotted.map((agent) => agent.workspace_id)),
        ];
        const [workspaces, paneInfos, tabLists] = await Promise.all([
          this.herdr.workspaceList(),
          this.herdr.paneList(),
          Promise.all(workspaceIds.map((id) => this.herdr.tabList(id))),
        ]);
        workspaceLabels = new Map(
          workspaces.map((w) => [w.workspace_id, w.label]),
        );
        panes = new Map(paneInfos.map((pane) => [pane.pane_id, pane]));
        tabLabels = new Map(
          tabLists
            .flat()
            .flatMap((tab) =>
              tab.label ? [[tab.tab_id, tab.label] as const] : [],
            ),
        );
      } catch (error) {
        log(`slot detail lookup failed: ${(error as Error).message}`);
      }
    }
    this.slotDetails = this.slots.map((terminalId, i) => {
      const agent = terminalId ? this.agents.get(terminalId) : undefined;
      if (!agent) return null;
      const pane = panes.get(agent.pane_id);
      const cwd = pane?.foreground_cwd ?? pane?.cwd ?? "";
      return {
        key: i + 1,
        paneId: agent.pane_id,
        agent: agent.agent ?? "agent",
        paneName: pane?.label ?? agent.name ?? null,
        workspace:
          workspaceLabels.get(agent.workspace_id) ?? agent.workspace_id,
        tab: tabLabels.get(agent.tab_id) ?? "",
        cwd: shortenHome(cwd),
        status: agent.agent_status,
      };
    });
  }

  private async pushLighting(): Promise<void> {
    const statuses = this.slots.map((terminalId): AgentStatus | null =>
      terminalId ? (this.agents.get(terminalId)?.agent_status ?? null) : null,
    );
    const lighting = slotLighting(statuses);
    const key = JSON.stringify(lighting);
    if (key === this.lastLighting || !this.device.connected) return;
    try {
      await this.device.setThreadLighting(lighting);
      this.lastLighting = key;
    } catch (error) {
      log(`lighting update failed: ${(error as Error).message}`);
    }
  }

  // Stamps each slotted agent's sidebar row with its key glyph via the $key
  // metadata token. Only confirmed writes update the cache, so failures retry
  // on the next refresh.
  private async updateKeyTokens(): Promise<void> {
    const desired = new Map<string, string>();
    this.slots.forEach((terminalId, i) => {
      const paneId = terminalId
        ? this.agents.get(terminalId)?.pane_id
        : undefined;
      if (paneId) desired.set(paneId, KEY_GLYPHS[i]!);
    });
    const ops: [string, string | null][] = [];
    for (const [paneId, glyph] of desired) {
      if (this.tokenPanes.get(paneId) !== glyph) ops.push([paneId, glyph]);
    }
    for (const paneId of this.tokenPanes.keys()) {
      if (!desired.has(paneId)) ops.push([paneId, null]);
    }
    if (ops.length === 0) return;
    const results = await Promise.allSettled(
      ops.map(([paneId, glyph]) => this.reportKeyToken(paneId, glyph)),
    );
    const next = new Map(this.tokenPanes);
    results.forEach((result, i) => {
      const [paneId, glyph] = ops[i]!;
      if (result.status === "fulfilled") {
        if (glyph) next.set(paneId, glyph);
        else next.delete(paneId);
      } else {
        log(
          `token update failed for ${paneId}: ${(result.reason as Error).message}`,
        );
      }
    });
    this.tokenPanes = next;
  }

  private reportKeyToken(
    paneId: string,
    glyph: string | null,
  ): Promise<unknown> {
    return this.herdr.request("pane.report_metadata", {
      pane_id: paneId,
      source: PLUGIN_ID,
      tokens: { key: glyph },
    });
  }

  // Stateless: probe by closing; a popup_not_open error means open one.
  private async togglePopup(): Promise<void> {
    try {
      await this.herdr.request("popup.close", {});
    } catch (error) {
      if (!(error as Error).message.startsWith("popup_not_open")) {
        log(`popup toggle failed: ${(error as Error).message}`);
        return;
      }
      try {
        await this.herdr.request("plugin.pane.open", {
          plugin_id: PLUGIN_ID,
          entrypoint: "keys",
          placement: "popup",
        });
      } catch (openError) {
        log(`popup open failed: ${(openError as Error).message}`);
      }
    }
  }

  private async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log("shutting down");
    this.subGeneration++;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.subRetryTimer) clearTimeout(this.subRetryTimer);
    if (this.chatGptTimer) clearInterval(this.chatGptTimer);
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    this.configWatcher?.close();
    this.closeSubscription?.();
    this.controls.releaseHeldKeys();
    if (this.device.connected) {
      await this.device
        .setThreadLighting(
          slotLighting(Array.from({ length: SLOT_COUNT }, () => null)),
        )
        .catch(() => {});
      await this.device.setAmbientLighting(RING_OFF).catch(() => {});
    }
    await Promise.allSettled(
      [...this.tokenPanes.keys()].map((paneId) =>
        this.reportKeyToken(paneId, null).catch(() => {}),
      ),
    );
    await this.device.stop();
    this.control.close();
    process.exit(0);
  }
}

new Daemon().start().catch((error: Error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});
