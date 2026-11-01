# screen-ink

A menu-bar app that lets any MCP agent (Claude Code, Codex, …) look at your screen and draw on it: rings,
arrows, name pills, step badges, dashed frames, highlights and handwriting, animated like a pen, plus small
3D figures that build part by part and move, in a transparent click-through overlay. Or press **⌥⇧Space**, ask a question, and your local `claude` CLI answers
by drawing. Either way it runs on whatever subscription the CLI is signed into.

```
agent ──MCP (HTTP, 127.0.0.1:7377)──▶ screen-ink main ──IPC──▶ overlay window (SVG + perfect-freehand, three.js)
          screenshot / draw / clear        │  ▲
                                           │  └─ ⌥⇧Space prompt bar ──▶ claude -p (screenshot + question → marks)
                                           └─ desktopCapturer (screenshot, scaled to ≤1280 wide)
```

## Run

```bash
sfw npm ci
```

```bash
npm start
```

A ✎ appears in the menu bar. Its menu has **Ask about the screen…** (⌥⇧Space anywhere), **Clear** (⌃⌥⎋
anywhere), **Draw demo** and **Draw 3D demo** (samples drawn over your screen without needing any
permission), and **Copy "claude mcp add" command**.

## Ask with the shortcut

Press ⌥⇧Space. screen-ink screenshots the display under the mouse, then opens a prompt bar on it. Type a
question (macOS Dictation works in the bar too) and press ↵. It runs:

```
claude -p --safe-mode --tools "" --model sonnet --json-schema <the drawing schema> …
```

with the screenshot and your question, and draws the answer for 45 seconds. `--safe-mode` keeps your login
but skips your hooks, CLAUDE.md, skills and MCP servers, so the call is quick (about 3–7 seconds with
Sonnet, or about 12 when the answer is a 3D figure) and none of your setup leaks in. Esc closes the bar and cancels a question in flight; pressing the
shortcut again does the same.

The first `screenshot` asks macOS for Screen Recording access. In development the permission belongs to
**Electron**. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then
restart `npm start`.

## Connect an agent

The server needs a bearer token, which screen-ink creates on first launch in
`~/Library/Application Support/screen-ink/token`.

Claude Code:

```bash
claude mcp add --transport http screen-ink http://127.0.0.1:7377/mcp --header "Authorization: Bearer $(cat ~/Library/Application\ Support/screen-ink/token)"
```

Codex reads the token from an environment variable, so export it in your shell profile first:

```bash
export SCREEN_INK_TOKEN="$(cat ~/Library/Application\ Support/screen-ink/token)"
```

```bash
codex mcp add screen-ink --url http://127.0.0.1:7377/mcp --bearer-token-env-var SCREEN_INK_TOKEN
```

Then ask something like *"look at my screen and show me where to change the font size"*, or *"how does a
bike's gearing work?"* for a 3D figure.

## Tools

| Tool | What it does |
| --- | --- |
| `screenshot` | Screenshot of the display under the mouse (or the main one), without screen-ink's own marks. Fixes the coordinate space for `draw`. |
| `draw` | Draws `marks` in order, plus an optional `caption`. Replaces the current drawing unless `append`; `fadeAfter` seconds makes it fade away. |
| `clear` | Erases everything. |

Marks (coordinates in screenshot units; `box` is `[x, y, w, h]`, points are `[x, y]`):

| kind | fields |
| --- | --- |
| `ring` | `box`: a loop around it |
| `arrow` | `from`, `to`, `bend` (-1..1): tip touches `to` |
| `label` | `text`, `box` or `at`, `side`: a pill beside the target |
| `badge` | `at`, `n`: a numbered step |
| `frame` | `box`, `text`: dashed region with a faint tint and a title pill |
| `underline` | `box` |
| `highlight` | `box`: translucent marker |
| `text` | `at`, `text`, `size`: handwriting |
| `line` | `points`: freehand |
| `spotlight` | `box`: dims everything else |
| `figure` | `box`, `title`, `parts`, `labels`, `view`, `turntable`: a 3D model on a card (below) |

Every mark but `spotlight` takes `color` and `delay`. The schema lives in
[src/shared/marks.ts](src/shared/marks.ts) and is what the agent sees.

### 3D figures

A `figure` stands a card on the screen and builds a model in it from up to 40 parts, one by one: `box`,
`cylinder`, `tube`, `sphere`, `cone`, `torus`, `capsule`, `gear`, `spring` and `arrow`. Each part has a
`size`, `at` and `rot` in the figure's own units (y up), a `color`, an `opacity` below 1 to see inside a
housing, and an optional `motion`: `spin`, `slide` or `swing` about an axis, with a `speed` in cycles per
second and a `phase` to keep linked parts in step (`pivot` moves the point it turns around). Up to 8
`labels` name parts or points; they sit in the card's margins with leader lines and follow their part as it
moves. The camera frames the whole model from `view` (yaw and pitch), and `turntable` slowly turns it.

It draws with three.js: toon shading, inked creases and a drawn outline, so it matches the pen marks.

## Develop

- `npm run preview` opens the overlay page in your browser, where it draws the demo over a mock window
  (2 for the pen demo, 3 for the 3D one, R to replay; `#3d` in the URL starts with 3D). The quickest way to
  work on the look.
- `npm run typecheck`, `npm run build`.
- Settings ([src/main/config.ts](src/main/config.ts)): `SCREEN_INK_PORT` (default 7377), `SCREEN_INK_COLOR`
  (ink hex, default `#FF5A36`), `SCREEN_INK_HOTKEY` (default `Alt+Shift+Space`, an
  [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)), `SCREEN_INK_MODEL`
  (default `sonnet`), `SCREEN_INK_CLAUDE` (path to `claude` when it isn't on `PATH`, as when launched from
  Finder), `SCREEN_INK_DEMO=1` (draw the demo on launch; `3d` draws the 3D demo).

| File | Role |
| --- | --- |
| [src/main/main.ts](src/main/main.ts) | Menu bar, token, shortcuts, startup |
| [src/main/mcp.ts](src/main/mcp.ts) | MCP server and tool descriptions (the drawing "skill" the agent reads) |
| [src/main/ask.ts](src/main/ask.ts) | The shortcut: screenshot, prompt bar, answer |
| [src/main/brain.ts](src/main/brain.ts) | Runs `claude -p` on a screenshot and question; its system prompt |
| [src/main/canvas.ts](src/main/canvas.ts) | The last screenshot's coordinate space, shared by MCP and the shortcut |
| [src/main/capture.ts](src/main/capture.ts) | Screenshots and the unit → point scale |
| [src/main/overlay.ts](src/main/overlay.ts) | The transparent, click-through window |
| [src/renderer/renderer.ts](src/renderer/renderer.ts) | Marks → animated beats |
| [src/renderer/shapes.ts](src/renderer/shapes.ts) | Hand-drawn geometry |
| [src/renderer/figure.ts](src/renderer/figure.ts) | 3D figures: parts, motion, framing, labels |
| [src/renderer/common.ts](src/renderer/common.ts) | Timing, easing and DOM helpers both renderers share |
| [src/shared/demo.ts](src/shared/demo.ts) | The pen and 3D demos |
| [src/renderer/ask.ts](src/renderer/ask.ts) | The prompt bar |

## Security

The server listens on 127.0.0.1 only, requires the bearer token, rejects any request carrying an `Origin`
header (browsers), and checks `Host` against DNS rebinding. Anyone holding the token can see your screen,
so keep it private.

## Next

1. **Grounding.** Agents' raw coordinates drift by tens of pixels. Add an `elements` list to `screenshot`
   (Accessibility tree frames plus Vision OCR boxes, each with an id) and let marks target `"el_42"`
   instead of `[x, y]`.
2. **Faster answers.** Stream the answer (`--include-partial-messages`) and draw each mark as soon as it
   is complete, instead of waiting for the whole JSON.
3. **Voice.** Push-to-talk on the shortcut, and speak each step (AVSpeechSynthesizer) while its strokes draw.
4. **Truer mechanisms.** Figures are only as right as the model's mechanics: it can still spin a gear the
   wrong way or misplace a part. Constraints (mesh these two gears, join this rod to that crank) would let
   screen-ink work out positions and speeds itself.
5. **Native port.** The renderer is plain web code, so it can move into a WKWebView in a Swift app.
