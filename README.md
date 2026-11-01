# screen-ink

A menu-bar app that lets any MCP agent (Claude Code, Codex, …) look at your screen and draw on it: rings,
arrows, name pills, step badges, dashed frames, highlights and handwriting, animated like a pen, in a
transparent click-through overlay. The agent runs on whatever subscription its CLI is signed into.

```
agent ──MCP (HTTP, 127.0.0.1:7377)──▶ screen-ink main ──IPC──▶ overlay window (SVG + perfect-freehand)
          screenshot / draw / clear        │
                                           └─ desktopCapturer (screenshot, scaled to ≤1280 wide)
```

## Run

```bash
sfw npm ci
```

```bash
npm start
```

A ✎ appears in the menu bar. Its menu has **Draw demo** (draws a sample over your screen without needing
any permission), **Clear** (⌃⌥⎋ anywhere), and **Copy "claude mcp add" command**.

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

Then ask something like *"look at my screen and show me where to change the font size"*.

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

Every mark but `spotlight` takes `color` and `delay`. The schema lives in
[src/shared/marks.ts](src/shared/marks.ts) and is what the agent sees.

## Develop

- `npm run preview` opens the overlay page in your browser, where it draws the demo over a mock window
  (press R to replay). The quickest way to work on the look.
- `npm run typecheck`, `npm run build`.
- Settings: `SCREEN_INK_PORT` (default 7377), `SCREEN_INK_COLOR` (ink hex, default `#FF5A36`),
  `SCREEN_INK_DEMO=1` (draw the demo on launch).

| File | Role |
| --- | --- |
| [src/main/main.ts](src/main/main.ts) | Menu bar, token, shortcut, startup |
| [src/main/mcp.ts](src/main/mcp.ts) | MCP server and tool descriptions (the drawing "skill" the agent reads) |
| [src/main/capture.ts](src/main/capture.ts) | Screenshots and the unit → point scale |
| [src/main/overlay.ts](src/main/overlay.ts) | The transparent, click-through window |
| [src/renderer/renderer.ts](src/renderer/renderer.ts) | Marks → animated beats |
| [src/renderer/shapes.ts](src/renderer/shapes.ts) | Hand-drawn geometry |

## Security

The server listens on 127.0.0.1 only, requires the bearer token, rejects any request carrying an `Origin`
header (browsers), and checks `Host` against DNS rebinding. Anyone holding the token can see your screen,
so keep it private.

## Next

1. **Grounding.** Agents' raw coordinates drift by tens of pixels. Add an `elements` list to `screenshot`
   (Accessibility tree frames plus Vision OCR boxes, each with an id) and let marks target `"el_42"`
   instead of `[x, y]`.
2. **Hotkey and voice.** A global shortcut that captures the screen, listens (SFSpeechRecognizer), and
   runs `claude -p --input-format stream-json --output-format stream-json --tools ""` with the
   screenshot, drawing marks as they stream in.
3. **Speech-paced drawing.** Speak each step (AVSpeechSynthesizer) and spread its strokes across it.
4. **Native port.** The renderer is plain web code, so it can move into a WKWebView in a Swift app.
