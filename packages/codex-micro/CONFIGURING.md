# Configuring codex-micro

Instructions for configuring the Codex Micro Herdr plugin, written so a
coding agent can follow them directly.

## Where the config lives

```bash
herdr plugin config-dir alasano.codex-micro
```

Edit `config.json` in that directory. The daemon watches the file and applies
changes within a second of saving; no restart is needed. If the new config is
invalid, the daemon keeps the previous configuration and reports the exact
validation error; read it with:

```bash
node dist/ctl.js status   # from the plugin directory; see "configError"
```

Every kind of invalid config is reported this way, not just bad bindings:
unparseable JSON, a root that is not an object, and an unknown `policy` all
keep the previous configuration and surface the error. A config file that is
merely absent is not an error - that is the default state.

Because the file is the source of truth, actions that persist a setting
(`toggle-policy`) refuse to write while it is unparseable rather than
overwrite it. Fix the reported error and the write succeeds.

## Schema

```json
{
  "policy": "sticky",
  "bindings": {
    "<input>": <binding>
  }
}
```

where `<binding>` is one of:

```
"<preset>"                          a preset name (see the table below)
"none"                              disable this input
{ "key": "cmd+shift+p" }            press a real key globally
{ "herdr-key": "esc" }              send a key to Herdr's focused pane
{ "herdr-text": "continue" }        type text into Herdr's focused pane
{ "exec": ["open", "x-app://x"] }   run a command
```

- `policy`: `"sticky"` (agents keep their key; default) or `"mirror"` (keys
  always match Herdr's attention priority order).
- `bindings`: optional. Omitted inputs keep their defaults. `"none"` disables
  an input.

## Inputs

| Input               | Physical control                                                                            | Default                   |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| `ACT06`             | first key below the agent keys                                                              | `popup`                   |
| `ACT07`             | second key                                                                                  | `{"herdr-key": "esc"}`    |
| `ACT08`             | third key                                                                                   | `tab-prev`                |
| `ACT09`             | fourth key                                                                                  | `tab-next`                |
| `ACT10`             | wide bar (mic cap)                                                                          | `none`                    |
| `ACT11`             | second half of the wide bar; fires only if the wide keycap is replaced with two single caps | `none`                    |
| `ACT12`             | bottom key (CODEX cap)                                                                      | `{"herdr-key": "enter"}`  |
| `ENC_CW` / `ENC_CC` | dial rotation (per tick)                                                                    | `dial-prev` / `dial-next` |
| `ENC_CLK`           | dial click                                                                                  | `dial-mode`               |
| `joystick`          | the stick                                                                                   | `"pane-nav"`              |

The six Agent Keys always focus their assigned agents and are not
configurable. `joystick` accepts `"pane-nav"` or per-direction overrides:
`{"up": <binding>, "down": ..., "left": ..., "right": ...}`; omitted
directions keep pane navigation.

## Binding kinds

1. **Preset** (string): a built-in Herdr behavior.

   | Preset                                 | Effect                                                       |
   | -------------------------------------- | ------------------------------------------------------------ |
   | `popup`                                | toggle the key-map popup                                     |
   | `tab-next` / `tab-prev`                | cycle tabs in the focused workspace                          |
   | `tab-new`                              | create a tab in the focused workspace                        |
   | `workspace-next` / `workspace-prev`    | cycle workspaces                                             |
   | `zoom`                                 | toggle zoom on the focused pane                              |
   | `pane-split-right` / `pane-split-down` | split the focused pane                                       |
   | `agent-next` / `agent-prev`            | cycle agents in priority order                               |
   | `toggle-policy`                        | flip sticky/mirror                                           |
   | `dial-next` / `dial-prev`              | mode-dependent cycling (see `dial-mode`)                     |
   | `dial-mode`                            | switch the dial between workspaces and agents; shows a toast |

   In agent mode the device's ambient ring glows blue; in workspace mode it
   is off. If no binding maps to `dial-mode`, the mode collapses back to
   workspaces (the ring cannot get stuck). The `dial-mode` toast additionally
   requires toast delivery enabled in Herdr, which is off by default: set
   `[ui.toast] delivery = "herdr"` in the Herdr config. The current mode is
   always visible in the popup header regardless.

2. **`{"key": "..."}`**: act as a real keyboard key, sent globally to the
   frontmost app. Requires the macOS Accessibility permission. Combo
   grammar: modifiers `cmd`, `shift`, `alt`/`opt`, `ctrl` joined with `+`,
   ending in a key name: letters, digits, `f1`-`f20`, `return`/`enter`,
   `escape`/`esc`, `tab`, `space`, `delete`/`backspace`, `forwarddelete`,
   `left`, `right`, `up`, `down`, `home`, `end`, `pageup`, `pagedown`,
   `minus`, `equal`, `leftbracket`, `rightbracket`, `backslash`,
   `semicolon`, `quote`, `comma`, `period`, `slash`, `grave`/`backtick`.

   Presses tap by default. Add `"hold": true` to mirror your physical
   press and release instead (`{"key": "cmd+shift+v", "hold": true}`), for
   hold-to-talk style hotkeys; synthetic holds do not auto-repeat. Bare
   modifier keys, standalone only, always mirror the hold: `lcmd`/`rcmd`,
   `lopt`/`ropt` (`lalt`/`ralt`), `lctrl`/`rctrl`, `lshift`/`rshift`, for
   apps that trigger on a bare modifier press, e.g. speech-to-text tools.

   **Holds need an input that reports a release.** Dial rotation (`ENC_CW`,
   `ENC_CC`) and joystick directions report entry only, so a hold bound
   there could never be released. Both `"hold": true` and bare modifier keys
   are rejected on those inputs, naming the entry, rather than silently
   degrading to a 30ms blip. Every other input, including the dial click
   `ENC_CLK`, supports holds.

3. **`{"herdr-key": "..."}`**: send a key into Herdr's focused pane (works
   even when Herdr is not the frontmost app; no permissions). Uses Herdr's
   key grammar: `esc`, `enter`, `ctrl+c`, `shift+tab`, `f1`, ...
4. **`{"herdr-text": "..."}`**: type literal text into Herdr's focused pane.
5. **`{"exec": ["cmd", "arg", ...]}`**: run a command on press (argv, no
   shell). Anything the `herdr` CLI can do fits here. The first element is
   the command and must not be empty.

A binding object names exactly one of `key`, `herdr-key`, `herdr-text` or
`exec`; declaring two is rejected rather than resolved by precedence.

## Examples

Bind the mic bar to a speech-to-text app triggered by right command, and the
CODEX key to Enter:

```json
{ "bindings": { "ACT10": { "key": "rcmd" }, "ACT12": { "key": "return" } } }
```

A button that tells the focused agent to continue:

```json
{ "bindings": { "ACT12": { "herdr-text": "continue" } } }
```

Joystick up runs a command (here, opening an app's URL scheme); the other
directions keep navigating panes:

```json
{
  "bindings": {
    "joystick": { "up": { "exec": ["open", "superwhisper://record"] } }
  }
}
```

## Opening the popup from the keyboard

Add to your Herdr config:

```toml
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "alasano.codex-micro.popup"
description = "codex micro keys"
```

The popup closes with `q` or Escape; Herdr plugin popups do not close on
outside clicks.

## Troubleshooting

```bash
node dist/doctor.js   # from the plugin directory
```

Checks the Herdr server, the daemon, config validity, ChatGPT-app contention,
device presence, Input Monitoring, and Accessibility, with guidance per
failure. After upgrading the plugin itself (new code, not config), run the
`restart` action or `node dist/restart.js`.
