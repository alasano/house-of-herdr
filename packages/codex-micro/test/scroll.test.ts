import { describe, expect, it, vi } from "vitest";
import { HerdrScroller } from "../src/scroll.js";
import type { ScrollOperation } from "../src/tapkey.js";

function completedOperation(): ScrollOperation {
  return { cancel: vi.fn(), done: Promise.resolve() };
}

function deferredOperation(): ScrollOperation & { finish(): void } {
  let finish!: () => void;
  return {
    cancel: vi.fn(),
    done: new Promise<void>((resolve) => (finish = resolve)),
    finish,
  };
}

function snapshot() {
  return {
    focused_pane_id: "wA:p1",
    panes: [{ pane_id: "wA:p1", tab_id: "wA:t1" }],
    layouts: [
      {
        tab_id: "wA:t1",
        area: { x: 26, y: 1, width: 189, height: 60 },
        panes: [
          { pane_id: "wA:p1", rect: { x: 26, y: 1, width: 95, height: 60 } },
        ],
      },
    ],
  };
}

const TERMINAL_ENV_KEYS = [
  "TERM_PROGRAM",
  "KITTY_WINDOW_ID",
  "ALACRITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
] as const;

async function inTerminalEnv(
  env: Partial<Record<(typeof TERMINAL_ENV_KEYS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = TERMINAL_ENV_KEYS.map(
    (key) => [key, process.env[key]] as const,
  );
  try {
    for (const key of TERMINAL_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("HerdrScroller", () => {
  it("posts native wheel events over Herdr's focused pane", () =>
    inTerminalEnv({ TERM_PROGRAM: "ghostty" }, async () => {
      const herdr = {
        sessionSnapshot: vi.fn(async () => snapshot()),
        request: vi.fn(async () => ({})),
      };
      const postHostScroll = vi.fn(completedOperation);
      const postFallbackScroll = vi.fn();
      const log = vi.fn();
      const scroller = new HerdrScroller(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        herdr as any,
        log,
        () => 2,
        postHostScroll,
        postFallbackScroll,
      );

      await scroller.scroll("up");
      await scroller.scroll("down");

      expect(postHostScroll.mock.calls).toEqual([
        [2, 73.5 / 215, 31 / 61, "Ghostty", log],
        [-2, 73.5 / 215, 31 / 61, "Ghostty", log],
      ]);
      expect(postFallbackScroll).not.toHaveBeenCalled();
      expect(herdr.request).not.toHaveBeenCalled();
    }));

  it.each([
    [
      {
        TERM_PROGRAM: "herdr",
        GHOSTTY_RESOURCES_DIR:
          "/Applications/Ghostty.app/Contents/Resources/ghostty",
      },
      "Ghostty",
    ],
    [
      {
        TERM_PROGRAM: "herdr",
        GHOSTTY_BIN_DIR: "/Applications/Ghostty.app/Contents/MacOS",
      },
      "Ghostty",
    ],
    [
      {
        TERM_PROGRAM: "herdr",
        GHOSTTY_RESOURCES_DIR: "/ghostty",
        KITTY_WINDOW_ID: "1",
      },
      "kitty",
    ],
    [
      {
        TERM_PROGRAM: "herdr",
        GHOSTTY_RESOURCES_DIR: "/ghostty",
        ALACRITTY_WINDOW_ID: "1",
      },
      "Alacritty",
    ],
    [{ TERM_PROGRAM: "herdr" }, null],
    [{ TERM_PROGRAM: "unknown", GHOSTTY_RESOURCES_DIR: "/ghostty" }, null],
  ] as const)("detects the host for environment %j", (env, owner) =>
    inTerminalEnv(env, async () => {
      const herdr = { sessionSnapshot: vi.fn(async () => snapshot()) };
      const postHostScroll = vi.fn(completedOperation);
      const postFallbackScroll = vi.fn(completedOperation);
      const log = vi.fn();
      const scroller = new HerdrScroller(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        herdr as any,
        log,
        () => 1,
        postHostScroll,
        postFallbackScroll,
      );
      await scroller.scroll("up");
      if (owner) {
        expect(postHostScroll).toHaveBeenCalledWith(
          1,
          73.5 / 215,
          31 / 61,
          owner,
          log,
        );
        expect(postFallbackScroll).not.toHaveBeenCalled();
      } else {
        expect(postHostScroll).not.toHaveBeenCalled();
        expect(postFallbackScroll).toHaveBeenCalledWith(1, log);
      }
    }),
  );

  it("prefers the terminal's own env var over an inherited TERM_PROGRAM", () =>
    inTerminalEnv(
      { TERM_PROGRAM: "ghostty", KITTY_WINDOW_ID: "1" },
      async () => {
        const herdr = {
          sessionSnapshot: vi.fn(async () => snapshot()),
          request: vi.fn(async () => ({})),
        };
        const postHostScroll = vi.fn(completedOperation);
        const scroller = new HerdrScroller(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          herdr as any,
          vi.fn(),
          () => 1,
          postHostScroll,
        );

        await scroller.scroll("up");

        expect(postHostScroll).toHaveBeenCalledWith(
          1,
          73.5 / 215,
          31 / 61,
          "kitty",
          expect.any(Function),
        );
      },
    ));

  it("falls back to system scrolling without pane geometry", async () => {
    const herdr = {
      sessionSnapshot: vi.fn(async () => ({ ...snapshot(), layouts: [] })),
      request: vi.fn(async () => ({})),
    };
    const postFallbackScroll = vi.fn(completedOperation);
    const log = vi.fn();
    const scroller = new HerdrScroller(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      herdr as any,
      log,
      () => 2,
      vi.fn(completedOperation),
      postFallbackScroll,
    );

    await scroller.scroll("down");

    expect(postFallbackScroll).toHaveBeenCalledWith(-2, log);
  });

  it("coalesces detents arriving while a scroll is in flight", () =>
    inTerminalEnv({ TERM_PROGRAM: "ghostty" }, async () => {
      const active = deferredOperation();
      try {
        const herdr = {
          sessionSnapshot: vi.fn(async () => snapshot()),
          request: vi.fn(async () => ({})),
        };
        const postHostScroll = vi
          .fn()
          .mockImplementationOnce(() => active)
          .mockImplementationOnce(completedOperation);
        let steps = 1;
        const scroller = new HerdrScroller(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          herdr as any,
          vi.fn(),
          () => steps,
          postHostScroll,
          vi.fn(completedOperation),
        );

        const done = scroller.scroll("down");
        await vi.waitFor(() => expect(postHostScroll).toHaveBeenCalledTimes(1));
        void scroller.scroll("down");
        steps = 3; // a live scroll_steps reload must not rescale the first detent
        void scroller.scroll("down");
        active.finish();
        await done;

        expect(postHostScroll.mock.calls.map(([lines]) => lines)).toEqual([
          -1, -4,
        ]);
        expect(herdr.sessionSnapshot).toHaveBeenCalledTimes(2);
      } finally {
        active.finish();
      }
    }));

  it("falls back to system scrolling when the snapshot lookup fails", async () => {
    const herdr = {
      sessionSnapshot: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      request: vi.fn(async () => ({})),
    };
    const postHostScroll = vi.fn(completedOperation);
    const postFallbackScroll = vi.fn(completedOperation);
    const log = vi.fn();
    const scroller = new HerdrScroller(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      herdr as any,
      log,
      () => 2,
      postHostScroll,
      postFallbackScroll,
    );

    await scroller.scroll("down");

    expect(postHostScroll).not.toHaveBeenCalled();
    expect(postFallbackScroll).toHaveBeenCalledWith(-2, log);
    expect(log).toHaveBeenCalledWith(
      "focus-aware scroll failed: socket closed",
    );
  });

  it("uses a backlogged reversal as a brake before scrolling back", () =>
    inTerminalEnv({ TERM_PROGRAM: "ghostty" }, async () => {
      const active = deferredOperation();
      let now = 1000;
      try {
        const herdr = {
          sessionSnapshot: vi.fn(async () => snapshot()),
          request: vi.fn(async () => ({})),
        };
        const postHostScroll = vi
          .fn()
          .mockImplementationOnce(() => active)
          .mockImplementationOnce(completedOperation);
        const scroller = new HerdrScroller(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          herdr as any,
          vi.fn(),
          () => 2,
          postHostScroll,
          vi.fn(completedOperation),
          () => now,
        );

        const first = scroller.scroll("up");
        await vi.waitFor(() => expect(postHostScroll).toHaveBeenCalledTimes(1));
        const buffered = scroller.scroll("up");
        await scroller.scroll("down");

        expect(active.cancel).toHaveBeenCalledTimes(1);
        expect(postHostScroll.mock.calls.map(([lines]) => lines)).toEqual([2]);

        now = 1119;
        await scroller.scroll("down");
        expect(postHostScroll).toHaveBeenCalledTimes(1);

        now = 1120;
        await scroller.scroll("down");
        expect(postHostScroll.mock.calls.map(([lines]) => lines)).toEqual([
          2, -2,
        ]);
        expect(herdr.sessionSnapshot).toHaveBeenCalledTimes(2);

        active.finish();
        await Promise.all([first, buffered]);
      } finally {
        active.finish();
      }
    }));
});
