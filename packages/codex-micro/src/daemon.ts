// The Codex Micro broker daemon: owns the HID connection, mirrors Herdr agent
// state onto the six Agent Key LEDs, and routes device input back into Herdr.
// Session-leased: if Herdr stays unreachable beyond the lease, the daemon
// clears the LEDs, releases the device, and exits.
import { chatGptRunning } from "./chatgpt.js";
import { CodexMicro } from "./device.js";
import {
  HerdrClient,
  HerdrError,
  subscribe,
  type AgentInfo,
  type PaneInfo,
  type Subscription,
} from "./herdr.js";
import fs from "node:fs";
import { Controls, type DialMode } from "./controls.js";
import { ControlServer, type SlotStatus } from "./control.js";
import { RING_AGENTS, RING_OFF, slotLighting } from "./lights.js";
import {
  assignSlots,
  SLOT_COUNT,
  type AgentStatus,
  type Policy,
} from "./slots.js";
import { defaultBindings, type Bindings } from "./bindings.js";
import {
  CONFIG_DIR,
  ensurePluginDirs,
  loadConfig,
  savePolicy,
  PLUGIN_ID,
} from "./config.js";

const REFRESH_DEBOUNCE_MS = 75;
const HERDR_RETRY_MS = 3000;
const HERDR_LEASE_MS = 60_000;
const CHATGPT_POLL_MS = 4000;
const CONFIG_RELOAD_DEBOUNCE_MS = 300;
const CONFIG_WATCH_RETRY_MS = 5000;
// Releasing the device outranks tidying Herdr's sidebar: if Herdr is wedged,
// stop waiting on it and finish shutting down.
const SHUTDOWN_CLEANUP_MS = 3000;
const KEY_GLYPHS = ["①", "②", "③", "④", "⑤", "⑥"];

const BASE_SUBSCRIPTIONS: Subscription[] = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
  // Renames change the labels the popup shows for a slot.
  { type: "workspace.renamed" },
  { type: "tab.renamed" },
];

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function shortenHome(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// Resolves either way after ms, so a wedged peer cannot stall an exit path.
function atMost(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

class Daemon {
  private herdr = new HerdrClient();
  private policy: Policy = "sticky";
  private bindings: Bindings = defaultBindings();
  private configError: string | null = null;
  private configWatcher: fs.FSWatcher | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;
  private configWatchRetryTimer: NodeJS.Timeout | null = null;
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
  private refreshing: Promise<void> | null = null;
  private refreshQueued: Promise<void> | null = null;
  private subGeneration = 0;
  private closeSubscription: (() => void) | null = null;
  private subRetryTimer: NodeJS.Timeout | null = null;
  private subscribedPanes = "";
  private herdrReached = false;
  private herdrLostAt: number | null = null;
  private yielded = false;
  private chatGptTimer: NodeJS.Timeout | null = null;
  private chatGptPolling = false;
  private stopping = false;

  private device = new CodexMicro(
    {
      onConnect: () => {
        this.lastLighting = "";
        void this.pushLighting();
        this.pushRing();
      },
      onDisconnect: () => this.controls.resetInputState(),
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
      slotPaneId: (slot) => this.agentForSlot(slot)?.pane_id ?? null,
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
      herdrConnected: this.herdrReached && this.herdrLostAt === null,
      configError: this.configError,
      slots: this.slotDetails,
    }),
    togglePolicy: () => this.togglePolicy(),
    popup: () => void this.togglePopup(),
    stop: () => void this.shutdown(),
    // Slot labels are resolved lazily; the arrival of a watcher is what makes
    // them worth fetching.
    watchersChanged: () => this.scheduleRefresh(),
  });

  async start(): Promise<void> {
    ensurePluginDirs();
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
  // Retries, because a watch that failed once must not disable hot-reload for
  // the life of the daemon.
  private watchConfig(): void {
    if (this.stopping) return;
    try {
      this.configWatcher = fs.watch(CONFIG_DIR, () => {
        if (this.configReloadTimer) return;
        this.configReloadTimer = setTimeout(() => {
          this.configReloadTimer = null;
          this.applyConfig();
        }, CONFIG_RELOAD_DEBOUNCE_MS);
      });
    } catch (error) {
      log(`config watch unavailable, retrying: ${(error as Error).message}`);
      this.configWatchRetryTimer = setTimeout(
        () => this.watchConfig(),
        CONFIG_WATCH_RETRY_MS,
      );
    }
  }

  private togglePolicy(): Policy {
    const next: Policy = this.policy === "sticky" ? "mirror" : "sticky";
    try {
      savePolicy(next); // the file watcher applies and broadcasts it
    } catch (error) {
      // Persisting over a config we could not parse would delete the user's
      // bindings, so refuse and report instead.
      this.configError = (error as Error).message;
      log(`policy not saved: ${this.configError}`);
      this.control.broadcast();
      return this.policy;
    }
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
    if (!this.device.connected || this.yielded || this.stopping) return;
    this.device
      .setAmbientLighting(
        this.controls.dialMode === "agents" ? RING_AGENTS : RING_OFF,
      )
      .catch((error: Error) => log(`ring update failed: ${error.message}`));
  }

  // Clears every LED and hands the device back. Used both when yielding to
  // the ChatGPT app and on shutdown.
  private async blankDevice(): Promise<void> {
    if (!this.device.connected) return;
    await this.device.setThreadLighting(slotLighting([])).catch(() => {});
    await this.device.setAmbientLighting(RING_OFF).catch(() => {});
  }

  private async pollChatGpt(): Promise<void> {
    // Overlapping polls could interleave a yield and a reclaim and leave the
    // device stopped while this.yielded says otherwise.
    if (this.stopping || this.chatGptPolling) return;
    this.chatGptPolling = true;
    try {
      const running = await chatGptRunning();
      if (this.stopping || running === this.yielded) return;
      this.yielded = running;
      if (running) {
        log("ChatGPT app detected, yielding the device");
        // Before the (possibly slow) HID writes below, and again inside the
        // device on disconnect, because there may be no live handle at all.
        this.controls.resetInputState();
        await this.blankDevice();
        await this.device.stop();
      } else {
        log("ChatGPT app gone, reclaiming the device");
        this.device.start();
      }
      this.control.broadcast();
    } finally {
      this.chatGptPolling = false;
    }
  }

  // Keeps one events connection alive, rebuilt whenever the agent pane set
  // changes (per-pane status subscriptions cannot be added incrementally).
  // Generation tags distinguish intentional closes from failures.
  private maintainSubscription(): void {
    if (this.stopping) return;
    const generation = ++this.subGeneration;
    void (async () => {
      try {
        // Awaiting a refresh that started after this call matters: Herdr
        // rejects the whole batch if any subscribed pane has since closed.
        await this.runRefresh();
        if (this.stopping || generation !== this.subGeneration) return;
        const panes = this.agentPaneIds();
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
          () =>
            this.onSubscriptionLost(
              generation,
              new Error("events connection closed"),
            ),
        );
        if (this.stopping || generation !== this.subGeneration) {
          close();
          return;
        }
        this.closeSubscription = close;
        this.subscribedPanes = panes.join(",");
        this.herdrReached = true;
        this.herdrLostAt = null;
        log(`subscribed to ${panes.length} agent panes`);
        // Reconcile anything that changed between the snapshot and the ack.
        this.scheduleRefresh();
      } catch (error) {
        this.onSubscriptionLost(generation, error as Error);
      }
    })();
  }

  private onSubscriptionLost(generation: number, error: Error): void {
    if (this.stopping || generation !== this.subGeneration) return;
    this.closeSubscription = null;
    // Herdr answering with an error proves it is reachable. It probes every
    // pane-scoped subscription at subscribe time and refuses the whole batch
    // if one pane has closed since the snapshot, which is a lost race, not a
    // dead server - counting it against the lease would exit the daemon and
    // go dark while Herdr was fine.
    if (error instanceof HerdrError) {
      this.herdrReached = true;
      this.herdrLostAt = null;
    } else {
      this.herdrLostAt ??= Date.now();
      if (Date.now() - this.herdrLostAt > HERDR_LEASE_MS) {
        log("herdr unreachable beyond lease, releasing device and exiting");
        void this.shutdown();
        return;
      }
    }
    log(`resubscribing in ${HERDR_RETRY_MS}ms: ${error.message}`);
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

  // Single-flight, and the returned promise always covers a refresh that
  // began no earlier than the call: awaiting it therefore guarantees a fresh
  // snapshot, which a caller building a subscription list depends on.
  private runRefresh(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = this.executeRefresh().finally(() => {
        this.refreshing = null;
      });
      return this.refreshing;
    }
    this.refreshQueued ??= this.refreshing
      .catch(() => {})
      .then(() => {
        this.refreshQueued = null;
        return this.runRefresh();
      });
    return this.refreshQueued;
  }

  private async executeRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      log(`refresh failed: ${(error as Error).message}`);
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

    if (
      this.closeSubscription &&
      this.agentPaneIds().join(",") !== this.subscribedPanes
    ) {
      this.rebuildSubscription();
    }
  }

  /** Sorted pane ids of every known agent; the subscription's identity. */
  private agentPaneIds(): string[] {
    return [...this.agents.values()].map((agent) => agent.pane_id).sort();
  }

  private agentForSlot(slot: number): AgentInfo | null {
    const terminalId = this.slots[slot] ?? null;
    return terminalId ? (this.agents.get(terminalId) ?? null) : null;
  }

  private slottedAgents(): (AgentInfo | null)[] {
    return this.slots.map((_, i) => this.agentForSlot(i));
  }

  // One failed lookup must not discard the ones that succeeded.
  private async orEmpty<T>(work: Promise<T[]>, what: string): Promise<T[]> {
    try {
      return await work;
    } catch (error) {
      log(`${what} lookup failed: ${(error as Error).message}`);
      return [];
    }
  }

  // Resolves the display facts the popup shows per slot: pane name, workspace
  // and tab labels, and the pane's live working directory. Those cost 2+N
  // socket round trips and feed nothing but the popup, so they are resolved
  // only while something is watching; otherwise the slots fall back to ids,
  // and the first watcher triggers a refresh that fills them in.
  private async updateSlotDetails(): Promise<void> {
    const agents = this.slottedAgents();
    const present = agents.filter(
      (agent): agent is AgentInfo => agent !== null,
    );
    let workspaceLabels = new Map<string, string>();
    let tabLabels = new Map<string, string>();
    let panes = new Map<string, PaneInfo>();
    if (present.length > 0 && this.control.hasWatchers) {
      const workspaceIds = [
        ...new Set(present.map((agent) => agent.workspace_id)),
      ];
      const [workspaces, paneInfos, tabLists] = await Promise.all([
        this.orEmpty(this.herdr.workspaceList(), "workspace"),
        this.orEmpty(this.herdr.paneList(), "pane"),
        Promise.all(
          workspaceIds.map((id) => this.orEmpty(this.herdr.tabList(id), "tab")),
        ),
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
    }
    this.slotDetails = agents.map((agent, i) => {
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
    if (this.yielded || this.stopping) return;
    const statuses = this.slottedAgents().map(
      (agent): AgentStatus | null => agent?.agent_status ?? null,
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
    this.slottedAgents().forEach((agent, i) => {
      if (agent) desired.set(agent.pane_id, KEY_GLYPHS[i]!);
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

  private async reportKeyToken(
    paneId: string,
    glyph: string | null,
  ): Promise<void> {
    try {
      await this.herdr.request("pane.report_metadata", {
        pane_id: paneId,
        source: PLUGIN_ID,
        tokens: { key: glyph },
      });
    } catch (error) {
      // Clearing a token on a pane Herdr has already forgotten has achieved
      // what it was for; treating it as a failure would retry and log it on
      // every refresh for the life of the daemon.
      if (
        glyph === null &&
        error instanceof HerdrError &&
        error.code === "pane_not_found"
      ) {
        return;
      }
      throw error;
    }
  }

  // Stateless: probe by closing; a popup_not_open error means open one.
  private async togglePopup(): Promise<void> {
    try {
      await this.herdr.request("popup.close", {});
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "popup_not_open") {
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
    if (this.configWatchRetryTimer) clearTimeout(this.configWatchRetryTimer);
    this.configWatcher?.close();
    this.closeSubscription?.();
    // Once here and once more when the handle drops, because there may be no
    // live handle to drop.
    this.controls.resetInputState();
    await this.blankDevice();
    // Bounded: a wedged Herdr must not keep the device held hostage.
    await atMost(
      Promise.allSettled(
        [...this.tokenPanes.keys()].map((paneId) =>
          this.reportKeyToken(paneId, null).catch(() => {}),
        ),
      ),
      SHUTDOWN_CLEANUP_MS,
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
