# screen-ink for Claude Code

Lets Claude Code see your screen and draw on it, through the [screen-ink](../README.md) app: rings and arrows on
the exact button, notes and code cards beside what they explain, charts, walkthroughs, and 3D figures of how
things work.

## Install

1. Install and open the screen-ink app once, so it can make its access token.
2. In Claude Code:

   ```
   /plugin marketplace add <owner>/<repo>
   /plugin install screen-ink@screen-ink
   ```

Then ask Claude Code to show you something ("where's the setting for…", "how does this work?") and it draws the
answer on your screen. The `/screen-ink:show` skill tells it how.

## How it connects

The plugin adds the app's MCP server at `http://127.0.0.1:7377/mcp`. It never leaves your computer: the app
listens on 127.0.0.1 only and needs a bearer token, which `scripts/headers.sh` reads from the app's data folder
each time Claude Code connects (or from `SCREEN_INK_TOKEN`, if you set it). Screenshots go to the model you are
already using in Claude Code, and nowhere else.
