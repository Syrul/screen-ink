# screen-ink

A menu-bar app that lets any MCP agent (Claude Code, Codex, …) look at your screen and draw on it: rings,
arrows, name pills, step badges, dashed frames, highlights and handwriting, animated like a pen, plus small
3D figures that build part by part and move, in a transparent click-through overlay, talking you through it
out loud as it draws. Or press **⌥⇧Space**, ask a question, and your local `claude` CLI answers by drawing. Either way it runs on whatever subscription the CLI is signed into.

```
agent ──MCP (HTTP, 127.0.0.1:7377)──▶ screen-ink main ──IPC──▶ overlay window (SVG + perfect-freehand, three.js)
          screenshot / draw / clear        │  ▲
                                           │  └─ ⌥⇧Space prompt bar ──▶ claude -p (screenshot + question → marks)
                                           ├─ desktopCapturer (screenshot, scaled to ≤1280 wide)
                                           └─ screen-ink-sense (Swift: Accessibility + Vision OCR → numbered elements)
```

## Run

```bash
sfw npm ci
```

```bash
npm start
```

The build also compiles a small Swift helper, `screen-ink-sense`, with Xcode's command-line tools
(`xcode-select --install` if you don't have them). Without it everything still works, but marks go where the
model guesses instead of snapping to real things (see [Pointing exactly](#pointing-exactly)).

A ✎ appears in the menu bar. Its menu has **Ask about the screen…** (⌥⇧Space anywhere), **Clear** (⌃⌥⎋
anywhere), **Draw demo** and **Draw 3D demo** (samples drawn over your screen without needing any
permission), **Speak answers** (voice on or off), and **Copy "claude mcp add" command**.

## Ask with the shortcut

Press ⌥⇧Space. screen-ink screenshots the display under the mouse, then opens a prompt bar on it, listening.
Say the question: the words show in the bar as you speak, and a one-second pause asks it. Or type: the first key
stops the listening and leaves what was heard there to edit, and ↵ asks (see [Listening](#listening)). It runs:

```
claude -p --safe-mode --tools WebSearch --allowedTools WebSearch --model sonnet --json-schema <the drawing schema> …
```

with the screenshot and your question, and draws the answer for 45 seconds. `--safe-mode` keeps your login
but skips your hooks, CLAUDE.md, skills and MCP servers, so the call is quick and none of your setup leaks
in. The answer streams: the bar goes and the first mark is drawn as soon as Claude has written it (about 1.5
seconds with Sonnet), and the rest follow as they come, so a 3D figure or a long walkthrough starts drawing
long before it is all written. It also skips the
`effortLevel` in your settings, so the CLI's default effort applies unless you set `SCREEN_INK_EFFORT`;
higher effort places marks more carefully but answers more slowly.

Claude can search the web when the answer depends on something the screen doesn't show and that may have
changed (versions, prices, docs, news). The bar shows each search while it runs, and a search adds about 10
seconds. It's Claude Code's own WebSearch tool, pre-approved because there's no one to answer a permission
prompt. `SCREEN_INK_TOOLS` picks other built-in tools (comma-separated, `""` for none). WebFetch is off by
default, since a page on your screen could talk Claude into sending what it sees to any URL. Esc closes the
bar and cancels a question in flight; pressing the shortcut again does the same, and pressing it while an
answer is still drawing stops that answer and opens a new bar (see [Voice](#voice)).

**Follow-ups.** The `claude` process starts when the bar opens, so it's ready by the time you've typed, and
stays for two minutes after each answer. Ask again within that time and the bar says *Ask a follow-up*: the
question continues the conversation ("and then?", "the other one"), with a fresh screenshot of the screen as
it is now. ⌘N in the bar starts a new conversation instead.

The first `screenshot` asks macOS for Screen Recording access. In development the permission belongs to
**Electron**. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then
restart `npm start`.

## Pointing exactly

A model reading a screenshot is often tens of pixels off, enough to ring the button next to the one it
means. So every screenshot also comes with a numbered list of what's on screen, and a mark can name an
element instead of giving coordinates: `{"kind": "ring", "box": "e12"}` lands exactly on element 12.

```
e5 menu "View" [163, 0, 42, 28]
e31 button "Go back" [208, 44, 27, 27]
e58 text "Sun 1 Nov 20:00" [1174, 7, 88, 14]
```

The list comes from `screen-ink-sense` ([native/sense.swift](native/sense.swift)), a helper that stays
running and answers in about 0.3 seconds, while you type:

- **Controls** from the Accessibility API: the frontmost app's menu bar and its windows on that display
  (buttons, menus, fields, checkboxes, tabs, links, rows and text). It skips what's scrolled out of view or
  behind another window. The frontmost app is the last one you used before the prompt bar opened.
- **Text** from Vision's OCR, read from a sharper 2560-wide copy of the screenshot so small text holds up.
  Vision joins words that share a line, so the helper splits a line where the gap between words is wider
  than the text is tall (a menu bar's titles, a toolbar's labels, table columns), and trims each box to the
  text's ink. A line inside a control names it when the control has no name of its own (icon buttons in
  web-based apps often don't).

Accessibility needs permission: the first screenshot asks for it (System Settings → Privacy & Security →
Accessibility; in development macOS may file it under Electron or under the app you ran `npm start` from).
Until it's on, the list has the text but not the controls. Ids belong to the screenshot that listed them; a mark naming
an id the last screenshot didn't have is left out, and `draw` says so. The first time a new build of the
helper runs, Vision spends up to a minute preparing its model, so the first screenshots may come without a
list.

## Voice

Every mark can carry a `say`: words spoken aloud as the mark starts to draw. The drawing waits at the end of
each mark until its words are out, so the pen keeps pace with the voice. With voice on, the shortcut asks
Claude to narrate its answer this way, and MCP agents are told about `say` too. A drawing with no `say` at
all has its caption read out instead. Clearing the screen or starting a new drawing cuts the voice off, and so
does pressing the shortcut: the bar opens at once, and if Claude was still writing, the answer stops there
while the conversation carries on, so the next question can build on it.

What's being said is captioned above the answer, each word lighting up as it's spoken (paced from the length
of the rendered audio, so it keeps time without word-level timings). **Caption what it says** in the menu
turns this off, and `SCREEN_INK_CAPTIONS=off` starts with it off.

The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open 82M-parameter speech model
(Apache 2.0), run on the CPU through [kokoro-js](https://www.npmjs.com/package/kokoro-js), so nothing leaves
your Mac. (The Claude app's own voices aren't reachable from the CLI.) The first launch downloads the model,
about 330 MB, into `~/Library/Application Support/screen-ink/models`; until it's ready, or if it fails to
load, macOS's `say` speaks instead. When a drawing arrives, its lines are rendered in order before their
marks come up (about half a second each on an M4 Max), so each mark's voice starts with its pen.

`SCREEN_INK_VOICE` picks a Kokoro voice (default `af_heart`; 54 in all, such as `af_bella`, `am_adam`,
`bf_emma` and `bm_george`, listed in [kokoro-js](https://www.npmjs.com/package/kokoro-js)), or `say` (or
`say:Ava`) for a macOS voice.

## Listening

The bar hears the question with [Moonshine](https://github.com/usefulsensors/moonshine), an open 61M-parameter
speech recognizer (MIT) built for live transcription, run on the CPU through transformers.js, so your voice never
leaves your Mac. It turns a spoken question into text in well under a tenth of a second (about 60 ms on an M4
Max), quick enough to redo the whole question every 0.6 seconds while you talk; Whisper base took four times as
long for the same words. The first launch downloads it, about 65 MB, next to the voice model. Speech is whatever is
well above the room's level, measured as the bar opens; a second of quiet after it ends the question, and seven
seconds of nothing stops the listening.

The first time the bar listens macOS asks for the microphone (in development, for Electron). **Listen when the bar
opens** in the menu turns listening off, and `SCREEN_INK_LISTEN=off` starts with it off.

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
| `screenshot` | Screenshot of the display under the mouse (or the main one), without screen-ink's own marks, plus the numbered list of elements on it. Fixes the coordinate space and the ids for `draw`. |
| `draw` | Draws `marks` in order, plus an optional `caption`. Replaces the current drawing unless `append`; `fadeAfter` seconds makes it fade away. |
| `clear` | Erases everything. |

Marks (coordinates in screenshot units; `box` is `[x, y, w, h]`, points are `[x, y]`). A ring's, label's,
frame's, underline's, highlight's or spotlight's `box`, an arrow's `from` and `to`, and a badge's `at` can be an
element id instead: a box becomes the element's, an arrow stops at its edge, and a badge sits just left of it.

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

Every mark takes `say` and `delay`, and every mark but `spotlight` takes `color`. The schema lives in
[src/shared/marks.ts](src/shared/marks.ts) and is what the agent sees.

### 3D figures

A `figure` stands a card on the screen and builds a model in it from up to 40 parts, one by one: `box`,
`cylinder`, `tube`, `sphere` (or an egg, with three radii), `cone`, `torus`, `capsule`, `gear`, `spring` and
`arrow`, plus three that take their shape from points: `lathe` turns a profile round the y axis (a valve, a
bottle), `extrude` gives a flat outline depth (a cam, a bracket) and `pipe` runs a tube smoothly through a path
(a hose, a wire). Each part has a `size`, `at` and `rot` in the figure's own units (y up), a `color`, an
`opacity` below 1 to see inside a housing, a `material` (`steel`, `brass`, `copper`, `glass`, `rubber`,
`plastic`, or the default flat `matte`), and an optional `motion`: `spin`, `slide` or `swing` about an axis,
with a `speed` in cycles per second and a `phase` to keep linked parts in step (`pivot` moves the point it turns
around). `copies` repeats a part round an axis (bolts on a flange, cylinders in a radial engine), in a row, or
mirrored, with a phase step so copies can move in sequence. Up to 8 `labels` name parts or points; they sit
beside the model with leader lines and follow their part as it moves. The camera frames the whole model from
`view` (yaw and pitch), and `turntable` slowly turns it.

After the build, up to 8 `steps` walk through how it works, each with its own `say`: it can move the camera
(`view`, with `zoom`, and `look` to centre on a part), cut the model open (`cut` along an axis, through chosen
parts, taking away the half nearest the camera and showing the cut faces), pull it apart (`explode`), fade all
but a few parts (`focus`), and play, pause or slow the motion. A step's change takes about a second and then
waits for its words, so the picture keeps pace with the voice; settings carry on until a later step changes
them.

The card can be handled: drag it to turn the model, and click a part to ask about it. The question goes to the
shortcut's conversation ("tell me about the crank…"), and the answer is drawn beside the figure, which stays.
The overlay lets clicks through everywhere else; it takes the mouse only while it is over a card, and a drawing
doesn't fade while you're handling it.

It draws with three.js: toon shading, inked creases and a drawn outline, so it matches the pen marks; metals and
glass are lit by a soft studio room so they shine, and keep the ink.

## Develop

- `npm run preview` opens the overlay page in your browser, where it draws the demo over a mock window
  (2 for the pen demo, 3 for the 3D one, R to replay; `#3d` in the URL starts with 3D). The quickest way to
  work on the look.
- `npm run typecheck`, `npm run build`.
- Settings ([src/main/config.ts](src/main/config.ts)): `SCREEN_INK_PORT` (default 7377), `SCREEN_INK_COLOR`
  (ink hex, default `#FF5A36`), `SCREEN_INK_HOTKEY` (default `Alt+Shift+Space`, an
  [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)), `SCREEN_INK_MODEL`
  (default `sonnet`), `SCREEN_INK_EFFORT` (`low`, `medium`, `high`, `xhigh` or `max`; unset, the CLI's
  default), `SCREEN_INK_CLAUDE` (path to `claude` when it isn't on `PATH`, as when launched from
  Finder), `SCREEN_INK_TOOLS` (Claude Code tools the shortcut may use, default `WebSearch`), `SCREEN_INK_VOICE`
  (a Kokoro voice, default `af_heart`; `say` or `say:<macOS voice>`; or `off` to start with voice off),
  `SCREEN_INK_CAPTIONS=off` (start without captions), `SCREEN_INK_LISTEN=off` (the bar only takes typing),
  `SCREEN_INK_DEMO=1` (draw the demo on launch; `3d` draws the 3D demo).

| File | Role |
| --- | --- |
| [src/main/main.ts](src/main/main.ts) | Menu bar, token, shortcuts, startup |
| [src/main/mcp.ts](src/main/mcp.ts) | MCP server and tool descriptions (the drawing "skill" the agent reads) |
| [src/main/ask.ts](src/main/ask.ts) | The shortcut: screenshot, prompt bar, answer |
| [src/main/brain.ts](src/main/brain.ts) | Keeps a `claude -p` conversation going and streams its answers; its system prompt |
| [src/main/stream.ts](src/main/stream.ts) | Picks each finished mark out of the answer's JSON as it is written |
| [src/main/canvas.ts](src/main/canvas.ts) | The last screenshot's coordinate space, shared by MCP and the shortcut |
| [src/main/capture.ts](src/main/capture.ts) | Screenshots and the unit → point scale |
| [src/main/sense.ts](src/main/sense.ts) | Runs the helper, merges its controls and text into the element list, places marks that name ids |
| [native/sense.swift](native/sense.swift) | The helper: Accessibility walk, Vision OCR, splitting lines by their ink |
| [src/main/overlay.ts](src/main/overlay.ts) | The transparent, click-through window |
| [src/main/voice.ts](src/main/voice.ts) | Speaks each mark's words with Kokoro, or `say` until it's ready |
| [src/main/listen.ts](src/main/listen.ts) | Turns the bar's recording into text with Moonshine |
| [src/renderer/renderer.ts](src/renderer/renderer.ts) | Marks → animated beats |
| [src/renderer/shapes.ts](src/renderer/shapes.ts) | Hand-drawn geometry |
| [src/renderer/figure.ts](src/renderer/figure.ts) | 3D figures: parts, motion, framing, labels |
| [src/renderer/common.ts](src/renderer/common.ts) | Timing, easing and DOM helpers both renderers share |
| [src/shared/demo.ts](src/shared/demo.ts) | The pen and 3D demos |
| [src/renderer/ask.ts](src/renderer/ask.ts) | The prompt bar: typing, or listening with the words live |
| [src/renderer/mic.ts](src/renderer/mic.ts) | Records the question at 16 kHz and tells when the speaker has finished |

## Security

The server listens on 127.0.0.1 only, requires the bearer token, rejects any request carrying an `Origin`
header (browsers), and checks `Host` against DNS rebinding. Anyone holding the token can see your screen,
so keep it private.

## Next

1. **Hold to talk.** The bar listens as it opens; holding the shortcut while speaking needs key-up events,
   which Electron's global shortcuts don't give.
2. **Truer mechanisms.** Figures are only as right as the model's mechanics: it can still spin a gear the
   wrong way or misplace a part. Constraints (mesh these two gears, join this rod to that crank) would let
   screen-ink work out positions and speeds itself.
3. **Web pages' controls.** Chromium browsers only open their page's Accessibility tree to assistive tech,
   so on web pages the list has the text but not the buttons and fields. Asking for it (`AXEnhancedUserInterface`)
   can slow the browser, so it's left off for now.
4. **Native port.** The renderer is plain web code, so it can move into a WKWebView in a Swift app.
