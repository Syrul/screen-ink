#!/bin/sh
# Prints the header that lets Claude Code into the screen-ink app: its token, which the app keeps in its data folder.
# SCREEN_INK_TOKEN, if set, wins (for a token kept elsewhere).
if [ -z "$SCREEN_INK_TOKEN" ]; then
  for f in "$HOME/Library/Application Support/screen-ink/token" "${XDG_CONFIG_HOME:-$HOME/.config}/screen-ink/token"; do
    [ -r "$f" ] && SCREEN_INK_TOKEN=$(cat "$f") && break
  done
fi
[ -n "$SCREEN_INK_TOKEN" ] || { echo "screen-ink isn't set up: open the app once." >&2; exit 1; }
printf '{"Authorization": "Bearer %s"}\n' "$SCREEN_INK_TOKEN"
