# Security

screen-ink can see your screen, run a local MCP server that agents connect to, and (on macOS) press buttons for
you. Problems in any of that matter, so please report them privately.

## Reporting a vulnerability

Use GitHub's private reporting: the **Security** tab of this repository → **Report a vulnerability**. Please don't
open a public issue.

Include what an attacker could do, the steps to reproduce it, and the version and OS you tested on. You'll get a
reply within a week; once it's fixed you'll be credited in the release notes unless you'd rather not be.

## In scope

- The MCP server on `127.0.0.1`: its bearer token, `Origin` and `Host` checks, and anything that lets a web page
  or another user on the machine reach it.
- Screenshots, the saved API key, memories and lessons leaving the machine or being readable by other apps.
- Marks, answers or fetched content (photos, LEGO instructions, LDraw parts) that run code or act on screen
  without the user asking.

Only the latest release is supported.
