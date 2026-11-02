# screen-ink

A companion for Claude Code: a menu-bar app that lets it (or any MCP agent, Codex included) look at your screen
and draw on it: rings, arrows, name pills, step badges, notes, checklists, code cards, charts and flowcharts, animated
like a pen, plus small 3D figures that build part by part and move, in a transparent click-through overlay, talking you
through it out loud as it draws. Or press **⌥⇧Space**, ask a question, and the Claude Code you have installed
answers by drawing, signed in as it is. Your own Anthropic API key or Codex can answer instead.

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
permission), switches for speaking, listening, captions and pen sounds, **Copy "claude mcp add" command**, and
**Settings…**.

## Settings and setup

The first launch opens **Settings**, which doubles as setup. Its top section shows what macOS has allowed
(Screen Recording, Accessibility, the microphone) with a button for each that asks or opens the right pane in
System Settings, and whether the model that answers is ready (`claude auth status`, or `codex login status`).

**Who answers the shortcut:**

- **Claude Code** (the default): your installed `claude`, signed in as it is.
- **Claude Code with your API key**: the same CLI run with `--bare`, which reads no login and bills the key. The
  key is kept encrypted with the system keychain (Electron's `safeStorage`), never in the settings file.
- **Codex**: your installed `codex exec`, signed in as it is, read-only, ephemeral and without your Codex config.
  It doesn't stream, so its marks arrive together, and a follow-up is a fresh run told what came before.

The rest are the model and effort, web search, checking 3D figures, the shortcut (any
[accelerator](https://www.electronjs.org/docs/latest/api/accelerator) with a modifier), the ink colour, the
voice, captions, listening and pen sounds, screen-ink's pointer, whether walkthroughs offer to do the clicking, what it remembers about you, saved lessons, the `claude mcp add` command,
and the licence. Each change is saved as
it is made, to `settings.json` in the app's data folder; an environment variable set at launch (below) wins over
it for that run.

**Licence keys** are offline: a key is the buyer's name and email signed with an Ed25519 private key, checked
against the public key built into the app. `node scripts/licence.mjs keygen <file>` makes the key pair (keep the
private key out of the repo) and prints the public key for `PUBLIC_KEY` in
[src/main/licence.ts](src/main/licence.ts); `node scripts/licence.mjs issue <file> --name … --email …` signs a key.
Nothing is locked without one yet: Settings just shows whose copy it is.

**Updates:** with `SCREEN_INK_UPDATE_FEED` set to an https JSON feed (`{"version": "…", "url": "https://…"}`),
the app checks it at launch and daily and offers the download in its menu. It doesn't install by itself.

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

**Walkthroughs.** For a task that takes several clicks ("turn on the path bar", "where do I change my DNS?"),
Claude shows only the first step and names what to click. screen-ink watches for that click (the helper listens
to left clicks while a step is up; it needs Accessibility), waits a moment for the menu or pane it opens, takes a
fresh screenshot and asks for the next step, until Claude says it's done. A step nobody clicks goes after five
minutes; the shortcut or ⌃⌥Esc stops the walk. Without Accessibility the first step is drawn as usual, and asking
again carries on.

**Do it for me.** Each walkthrough step has a *Do it for me* button. Click it and screen-ink does the steps
itself: each is drawn and said first, held for at least a second, then its pointer (below) moves there and shows the
press, named, and the control is pressed through the Accessibility API (its own press action, so your mouse doesn't
move), and the next step follows without waiting. Fields are
focused rather than pressed; where the app has no press action there (most web pages), it clicks the spot like a
mouse and puts the pointer back. It never presses a password field, and it leaves a step to you when the answer marks
it final (it sends, buys, deletes, signs in, installs or grants access) or when the button, menu item, link or
checkbox says so (Send, Buy, Delete, Confirm, Install, Allow, OK and the like): the caption says *This one is yours*,
and once you click it the next step offers the button again. *Stop*, the shortcut or ⌃⌥Esc hand the clicking back.
It only presses what the app in front has at that spot, and only after you clicked the button; a step can't turn it
on by itself. **Offer to do walkthroughs for me** in Settings (or `SCREEN_INK_DO_IT=off`) takes the button away.

**Memory.** An answer can keep a short fact about you ("uses VS Code with the Vim keys", "is new to Blender"), so
later conversations start out knowing it. Facts go in `memory.json` in the app's data folder (at most 40, the
oldest dropped first), are listed in Settings where each can be forgotten, and are given to the model at the start
of each conversation. It is told never to keep passwords, keys, money, health or other people's details, or anything
just read off the screen. Off in Settings, nothing is kept or given.

**Handing work to Claude Code.** Ask for work done in a project ("fix this error", "write the script") and the
answer can offer a button that hands it over: it opens Terminal on your `claude` with the task, in the project's
folder when the screen showed one inside your home folder (else in your home folder). It's an ordinary interactive
session, so you watch it and approve its steps as usual. It is connected to screen-ink and asked to keep you posted
with `progress`, a checklist in the corner of the screen, the one screen-ink tool it may use without asking. The
task reaches `claude` through a file, never through the shell's parsing. macOS only for now.

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

## screen-ink's pointer

A second pointer, in the ink's colour, does the pointing. When a drawing starts it leaves your mouse and moves to
each mark as the pen draws it, in a gentle arc: over a target the way a hand hovers, to the end of an arrow or a
stroke, beside a card rather than on it. A walkthrough step leaves it resting on what to click, and *Do it for me*
shows each press with it: the pointer dips, a ring spreads from its tip, and a tag says what it is pressing. It is
only drawn, so your own mouse stays yours. **Show screen-ink's pointer** in Settings (or `SCREEN_INK_CURSOR=off`)
turns it off.

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

Claude Code, as a plugin from this repository's marketplace. It reads the token itself each time it connects
(`plugin/scripts/headers.sh`), and adds a `/screen-ink:show` skill:

```
/plugin marketplace add <owner>/<repo>
/plugin install screen-ink@screen-ink
```

Or Claude Code with the server alone:

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
| `draw` | Draws `marks` in order, plus an optional `caption`. Replaces the current drawing unless `append`; `fadeAfter` seconds makes it fade away. A mark with an `id` can be changed later: with `append`, a mark with the same id replaces it, and `remove` takes marks away by id. |
| `progress` | A checklist in the corner of the screen (`title`, `steps` with `todo`, `doing`, `done` or `failed`), for keeping the user posted on a task. Needs no screenshot, sits over the rest of the drawing, and fades 20 seconds after every step is done or failed. |
| `save_lesson` | Keeps the last drawing, with what was appended to it, as a lesson (optional `title`). |
| `lessons` | Lists the saved lessons. |
| `show_lesson` | Draws a lesson again by `id`, scaled to the display. Needs no screenshot. |
| `clear` | Erases everything. |

Marks (coordinates in screenshot units; `box` is `[x, y, w, h]`, points are `[x, y]`). A ring's, label's,
frame's, underline's, highlight's, spotlight's or card's `box`, an arrow's or connector's `from` and `to`, and a
badge's, check's or cross's `at` can be an element id instead: a box becomes the element's, an arrow stops at its
edge, and a badge sits just left of it.

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
| `check`, `cross` | `at`: a tick or a cross, to judge options |
| `strike` | `box`: a line through it, for what's wrong or out of date |
| `connect` | `from`, `to` (boxes), `text`: a curve tying two things together, dots at its ends |
| `note` | `box` or `at`, `side`, `title`, `text`: a few sentences on a card beside the target |
| `steps` | `box` or `at`, `side`, `title`, `items` (`text`, `state`): a checklist card with ticks, a spinner and crosses; send it again with the same `id` as things move on |
| `code` | `box` or `at`, `side`, `code`, `title`, `highlight` (line numbers): a code card with a Copy button |
| `math` | `box` or `at`, `side`, `tex`: a typeset formula (LaTeX, rendered by [Temml](https://temml.org) to MathML) |
| `plot` | `box`, `title`, `x`, `y`, `series` (lines of points) or `bars`: a chart on a card, axes scaled to the data |
| `timeline` | `box`, `title`, `events` (`when`, `text`): events along a line |
| `flow` | `box`, `title`, `nodes` (`box`, `round` or `diamond`), `edges`, `direction`: a flowchart that lays itself out |
| `photo` | `box`, `url`, `source`, `caption`: a photo from Wikimedia Commons with its source (below) |
| `action` | `box` or `at`, `side`, `text`, `do` (`copy`, `open`, `type` or `agent`), `value`, `folder`: a button (below) |
| `figure` | `box`, `title`, `parts`, `labels`, `view`, `turntable`: a 3D model on a card (below) |

Every mark takes `say`, `delay` and `id`, and every mark but `spotlight` takes `color`.

**Buttons.** An `action` does nothing until the user clicks it. `copy` puts its value on the clipboard. `open`
opens a web page (`https:` only) or a System Settings pane (`x-apple.systempreferences:`). `type` types its value
into the app in front, as if from the keyboard (the overlay never takes focus, so that's the app you were in);
it needs Accessibility, and a value with a line break is copied instead, so a button can never press Return for
you. `agent` hands its value, a task, to Claude Code in Terminal, in `folder` if it is in your home folder (see
[Handing work to Claude Code](#ask-with-the-shortcut)). A code card's Copy button and a photo's source link work
the same way.

**Lessons.** Lessons → Save the last drawing in the menu, or `save_lesson`, keeps the drawing on screen, with what
was appended to it since, as a JSON file in the `lessons` folder of the app's data. Pick it from Lessons in the
menu, Show in Settings, or `show_lesson`, and it draws again on the display under the mouse, scaled to fit, its
words said again. A `progress` checklist isn't part of it.

**Photos** are fetched by the app, not the overlay page, and only from `upload.wikimedia.org` unless
`SCREEN_INK_PHOTO_HOSTS` lists others: the address is chosen by a model that has seen your screen, so an open
fetch could carry what's on it anywhere. Only PNG, JPEG, GIF, WebP and AVIF up to 6 MB, within 6 seconds.

**Pen sounds.** A soft scratch while a stroke draws and a tap as a card lands, made from filtered noise on the
spot. **Pen sounds** in the menu turns them off, and `SCREEN_INK_SOUNDS=off` starts without them. The schema lives in
[src/shared/marks.ts](src/shared/marks.ts) and is what the agent sees.

### 3D figures

A `figure` stands a card on the screen and builds a model in it from up to 40 parts, one by one: `box`,
`cylinder`, `tube`, `sphere` (or an egg, with three radii), `cone`, `torus`, `capsule`, `gear`, `spring` and
`arrow`, plus three that take their shape from points: `lathe` turns a profile round the y axis (a valve, a
bottle), `extrude` gives a flat outline depth (a cam, a bracket) and `pipe` runs a tube smoothly through a path
(a hose, a wire). Each part has a `size`, `at` and `rot` in the figure's own units (y up), a `color`, an
`opacity` below 1 to see inside a housing, a `material` (`steel`, `brass`, `copper`, `glass`, `rubber`,
`plastic`, or the default flat `matte`), and an optional `motion` about an axis: `spin`, `slide` or `swing` at
a `speed` in cycles per second (`pivot` moves the point it turns around), or one timed by physics, with figure
units taken as metres: a `pendulum` swings at the pace gravity gives its length (a rod and its bob hung from one
point swing as one), a `bounce` drops and bounces in parabolas, squashing a little as it lands, and an `orbit`
circles. A pipe can `flow`: beads stream along it, for fuel, air or current. `copies` repeats a part round an axis (bolts on a flange, cylinders in a radial engine), in a row, or
mirrored, with a phase step so copies can move in sequence. Up to 8 `labels` name parts or points; they sit
beside the model with leader lines and follow their part as it moves. The camera frames the whole model from
`view` (yaw and pitch), and `turntable` slowly turns it.

`links` say how parts drive each other, and screen-ink works the mechanism out
([src/shared/mechanism.ts](src/shared/mechanism.ts)), so only the driving part needs a motion:

- `mesh`: two gears. The second is moved to touch the first, sized so their teeth are the same size, and turns
  the other way at the ratio of their teeth, its teeth between the first's.
- `belt`: two pulleys (or sprockets, on a chain) turn the same way at the ratio of their radii (or teeth); the
  belt is drawn round both, with beads running along it at the belt's speed.
- `shaft`: two parts on one axle turn together, and move together when one is placed by a mesh.
- `crank`: a crank turns, its pin drives a rod, and the rod pushes a slider (a piston) along the line to it.
  The rod is placed and stretched to fit and runs in front of the crank's face, and a pin is added if the figure
  has none.
- `stretch`: a spring keeps its foot where it stands and its top on a moving part.

Speeds pass along chains of links, a set is slowed together if a small gear would spin fast enough to flicker,
and what can't work (a ring of three gears that would jam, a piston too close for a rod, a name that isn't a
part's) is reported: the MCP `draw` tool tells the agent, and in deep mode the shortcut holds the figure back
and asks Claude to fix it first.

After the build, up to 8 `steps` walk through how it works, each with its own `say`: it can move the camera
(`view`, with `zoom`, and `look` to centre on a part), cut the model open (`cut` along an axis, through chosen
parts, taking away the half nearest the camera and showing the cut faces), pull it apart (`explode`), fade all
but a few parts (`focus`), and play, pause or slow the motion. A step's change takes about a second and then
waits for its words, so the picture keeps pace with the voice; settings carry on until a later step changes
them.

The card can be handled: drag it to turn the model, and click a part to ask about it. The question goes to the
shortcut's conversation ("tell me about the crank…"), and the answer is drawn beside the figure, which stays.
Once built, the card has **Replay**, which walks through the steps again with their words, and **Save 3D**,
which saves the model as it stands to Downloads as USDZ: Quick Look opens it on the Mac, and an iPhone stands it
on a table in AR.
The overlay lets clicks through everywhere else; it takes the mouse only while it is over a card, and a drawing
doesn't fade while you're handling it.

It draws with three.js: toon shading, inked creases and a drawn outline, so it matches the pen marks; metals and
glass are lit by a soft studio room so they shine, and keep the ink.

## Develop

- `npm run preview` opens the overlay page in your browser, where it draws the demo over a mock window
  (2 for the pen demo, 3 for the 3D one, R to replay; `#3d` in the URL starts with 3D). The quickest way to
  work on the look; `drawPreview(marks, caption, { append, remove })` in its console draws any marks, and
  `pressPreview([x, y], label)` shows the pointer's press.
- `npm run typecheck`, `npm run build`.
- Environment ([src/main/settings.ts](src/main/settings.ts), [src/main/config.ts](src/main/config.ts)), each
  winning over Settings for that run: `SCREEN_INK_PROVIDER` (`claude-code`, `api-key` or `codex`),
  `SCREEN_INK_CODEX` (path to `codex`), `SCREEN_INK_PORT` (default 7377), `SCREEN_INK_COLOR`
  (ink hex, default `#FF5A36`), `SCREEN_INK_HOTKEY` (default `Alt+Shift+Space`, an
  [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)), `SCREEN_INK_MODEL`
  (default `sonnet`), `SCREEN_INK_EFFORT` (`low`, `medium`, `high`, `xhigh` or `max`; unset, the CLI's
  default), `SCREEN_INK_CLAUDE` (path to `claude` when it isn't on `PATH`, as when launched from
  Finder), `SCREEN_INK_TOOLS` (Claude Code tools the shortcut may use, default `WebSearch`), `SCREEN_INK_VOICE`
  (a Kokoro voice, default `af_heart`; `say` or `say:<macOS voice>`; or `off` to start with voice off),
  `SCREEN_INK_CAPTIONS=off` (start without captions), `SCREEN_INK_LISTEN=off` (the bar only takes typing),
  `SCREEN_INK_CHECK` (`on` or `off`: deep mode, which checks figures and has Claude fix them before they are
  drawn; on by default at `high` effort and above), `SCREEN_INK_SOUNDS=off` (start without pen sounds),
  `SCREEN_INK_DO_IT=off` (walkthroughs don't offer to click their steps), `SCREEN_INK_CURSOR=off` (no screen-ink pointer),
  `SCREEN_INK_PHOTO_HOSTS` (hosts photos may come from, comma-separated; default `upload.wikimedia.org`), `SCREEN_INK_UPDATE_FEED` (the update feed), `SCREEN_INK_LICENCE_PUBLIC_KEY` (a PEM public key to check licences
  against in a development run; a packaged app only uses the built-in one), `SCREEN_INK_DEMO=1` (draw the demo on launch; `3d` draws the 3D demo).

| File | Role |
| --- | --- |
| [src/main/main.ts](src/main/main.ts) | Menu bar, token, shortcuts, startup |
| [src/main/mcp.ts](src/main/mcp.ts) | MCP server and tool descriptions (the drawing "skill" the agent reads) |
| [src/main/ask.ts](src/main/ask.ts) | The shortcut: screenshot, prompt bar, answer |
| [src/main/brain.ts](src/main/brain.ts) | Keeps a `claude -p` conversation going and streams its answers; picks the engine |
| [src/main/answer.ts](src/main/answer.ts) | What an answer is, the system prompt, and what an engine offers |
| [src/main/codex.ts](src/main/codex.ts) | Codex as the engine: one `codex exec` per question |
| [src/main/memory.ts](src/main/memory.ts) | Facts about the user kept between conversations |
| [src/main/handoff.ts](src/main/handoff.ts) | Opens Claude Code in Terminal on a task from an agent button |
| [src/main/lessons.ts](src/main/lessons.ts) | Follows the drawing on screen, saves it as a lesson, and gives it back to draw again |
| [src/main/settings.ts](src/main/settings.ts) | Saved settings, the environment's overrides, the encrypted API key |
| [src/main/settings-window.ts](src/main/settings-window.ts), [src/renderer/settings.ts](src/renderer/settings.ts) | Settings and first-run setup |
| [src/main/licence.ts](src/main/licence.ts), [scripts/licence.mjs](scripts/licence.mjs) | Offline Ed25519 licence keys |
| [src/main/update.ts](src/main/update.ts) | Checks the update feed |
| [plugin/](plugin) | The Claude Code plugin: the MCP server, its token helper, and the `show` skill |
| [src/main/stream.ts](src/main/stream.ts) | Picks each finished mark out of the answer's JSON as it is written |
| [src/main/canvas.ts](src/main/canvas.ts) | The last screenshot's coordinate space, shared by MCP and the shortcut |
| [src/main/capture.ts](src/main/capture.ts) | Screenshots and the unit → point scale |
| [src/main/sense.ts](src/main/sense.ts) | Runs the helper, merges its controls and text into the element list, places marks that name ids |
| [native/sense.swift](native/sense.swift) | The helper: Accessibility walk, Vision OCR, splitting lines by their ink; typing for buttons, watching clicks for walkthroughs, pressing steps for "Do it for me" |
| [src/main/photos.ts](src/main/photos.ts) | Fetches photo marks' images, from allowed hosts only |
| [src/main/overlay.ts](src/main/overlay.ts) | The transparent, click-through window |
| [src/main/voice.ts](src/main/voice.ts) | Speaks each mark's words with Kokoro, or `say` until it's ready |
| [src/main/listen.ts](src/main/listen.ts) | Turns the bar's recording into text with Moonshine |
| [src/renderer/renderer.ts](src/renderer/renderer.ts) | Marks → animated beats |
| [src/renderer/shapes.ts](src/renderer/shapes.ts) | Hand-drawn geometry |
| [src/renderer/ink.ts](src/renderer/ink.ts) | The pen: strokes, pills and pop-ins every mark is made of |
| [src/renderer/cards.ts](src/renderer/cards.ts) | Notes, checklists, code, formulas, photos and buttons, as HTML cards |
| [src/renderer/charts.ts](src/renderer/charts.ts) | Plots, timelines and auto-laid-out flowcharts |
| [src/renderer/sounds.ts](src/renderer/sounds.ts) | The pen's scratch and tap |
| [src/renderer/pointer.ts](src/renderer/pointer.ts) | screen-ink's own pointer: where it goes for each mark, its glide and its press |
| [src/renderer/figure.ts](src/renderer/figure.ts) | 3D figures: parts, motion, framing, labels, steps, replay and saving |
| [src/shared/mechanism.ts](src/shared/mechanism.ts) | Works out linked parts: gear spacing and phase, speeds, cranks, belts, gravity's timing |
| [src/shared/check.ts](src/shared/check.ts) | What's wrong with a figure, for the agent or for deep mode |
| [src/renderer/common.ts](src/renderer/common.ts) | Timing, easing and DOM helpers both renderers share |
| [src/shared/demo.ts](src/shared/demo.ts) | The pen and 3D demos |
| [src/renderer/ask.ts](src/renderer/ask.ts) | The prompt bar: typing, or listening with the words live |
| [src/renderer/mic.ts](src/renderer/mic.ts) | Records the question at 16 kHz and tells when the speaker has finished |

## Package

```bash
npm run dist
```

builds `release/screen-ink-<version>-arm64-mac.zip` with [electron-builder](https://www.electron.build), for the
Mac you're on (`npm run dist:dir` builds just the `.app`, quicker; `npm run dist:dmg` a disk image, though on
macOS 27 electron-builder's dmgbuild currently fails at `hdiutil convert`, so the zip is the default). The Swift helper and the native ONNX
runtime are unpacked beside the app's archive so they can run, the web runtime and source maps are left out, and
the app is a menu-bar app (`LSUIElement`) with usage strings for the microphone and the screen.

It is **not signed**: `mac.identity` is `null`, so a build never picks up a certificate from your keychain. To
ship, set `mac.identity` to your Developer ID, turn on `hardenedRuntime` with entitlements for the microphone and
JIT, and notarize; until then macOS asks the user to open it from System Settings → Privacy & Security, and each
build counts as a new app for Screen Recording and Accessibility.

**Windows and Linux.** The code runs there without the Mac-only parts: no element list (marks use coordinates),
no typing buttons, walkthrough clicks or Do it for me, no `say` (Kokoro plays through PowerShell on Windows), and a tray icon
instead of the ✎ title. `claude` and `codex` must be `.exe`s on `PATH` or set by full path in Settings (npm's
`.cmd` shims can't be run without a shell), and the plugin's token helper needs a POSIX shell, so on Windows
set `SCREEN_INK_TOKEN` and use the `claude mcp add` command instead. `electron-builder --win` and `--linux` are
configured but untested.

## Security

The server listens on 127.0.0.1 only, requires the bearer token, rejects any request carrying an `Origin`
header (browsers), and checks `Host` against DNS rebinding. Anyone holding the token can see your screen,
so keep it private.

## Next

1. **Hold to talk.** The bar listens as it opens; holding the shortcut while speaking needs key-up events,
   which Electron's global shortcuts don't give.
2. **More mechanisms.** Links cover gears, belts, shafts, cranks and springs; racks, cams, bevel gears,
   escapements and linkages (four-bar, Watt's) would follow the same pattern.
3. **Web pages' controls.** Chromium browsers only open their page's Accessibility tree to assistive tech,
   so on web pages the list has the text but not the buttons and fields. Asking for it (`AXEnhancedUserInterface`)
   can slow the browser, so it's left off for now.
4. **Native port.** The renderer is plain web code, so it can move into a WKWebView in a Swift app.
5. **Hand-off everywhere.** Opening a terminal on Windows and Linux, and letting Codex take a task as well as
   Claude Code.
6. **Lessons to step through.** A saved lesson plays straight through; pausing between marks until the user
   clicks would make it a tutorial.
