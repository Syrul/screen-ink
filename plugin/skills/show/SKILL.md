---
description: Show the user something on their own screen instead of describing it. Use when they ask where something is, how to do something in an app that's open, or how something works, and a mark or a picture beside it would say it faster than words. Needs the screen-ink app running.
---

# Show it on the screen

screen-ink draws on the user's screen, over whatever is open, like a friend pointing with a pen.

1. Call `screenshot`. It returns the image, its size in units, and a numbered list of what's on screen (buttons,
   menus, fields, lines of text) with ids like `e12`.
2. Call `draw` with marks in that screenshot's units. Name things by id where the list has them: an id lands
   exactly on the element, coordinates are only an estimate.
3. Say the answer in the `caption` and in each mark's `say`, briefly; the marks point, the words explain.

Pick the fewest marks that answer:

- To point: `ring` or `frame` the target, a `label` pill beside it, `badge` numbers for steps, an `arrow` from your
  words to it.
- To judge: `check` and `cross` on options, `strike` through what's wrong.
- To explain beside it: a `note`, a `code` card for a command (it has a Copy button), `math`, a `plot`,
  `timeline` or `flow`, or a `photo` from Wikimedia Commons with its source.
- To act: an `action` button that copies, opens a page or settings pane, or types into the field in front, once
  the user clicks it.
- For how something works: a 3D `figure` on calm space beside it, with `links` between parts that drive each
  other and `steps` that walk through it.

For a task of several clicks, draw one step, wait for the user to do it, take a new screenshot, and draw the next.
When what you need is out of view (further down a web page, in a long list), `scroll` brings it in; then take a new
screenshot before drawing.
Give a mark an `id` to change it later with `append` (same id replaces it) or `remove`. Call `clear` when done.

While you work on something the user is waiting for, keep them posted with `progress`: a checklist in the corner
of the screen, sent again as each step starts, finishes or fails. It needs no screenshot. When a drawing is worth
keeping (a lesson they will want again), `save_lesson` keeps it, and `show_lesson` draws it again later.
