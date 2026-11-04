# Contributing to screen-ink

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Getting started

screen-ink is an Electron app. You need Node.js 22 or newer, and on macOS Xcode's command-line tools
(`xcode-select --install`) for the Swift helper that reads what's on screen; without them it still runs, with
marks placed by guessed coordinates.

```bash
git clone https://github.com/Syrul/screen-ink.git
cd screen-ink
npm ci
npm start
```

`npm run preview` opens the overlay in a browser with a demo drawing, which is the quickest way to work on how
marks look. The README's [Develop](README.md#develop) section lists the environment variables and what each file does.

## Before you open a pull request

- `npm run typecheck` and `npm run build` pass (CI runs both).
- Try the change in the running app, and say in the PR how you checked it. A screenshot or short clip helps for
  anything visible.
- Keep each pull request to one change. Small ones get reviewed faster.
- Commit messages are one line: `type(scope): imperative summary`, for example `fix(build): find steps by font size`.

## Reporting bugs

Open an issue with what you did, what you expected, what happened, your OS and screen-ink version, and which
engine answered (Claude Code, an API key or Codex). Leave screenshots of anything private out.

Security problems go privately, not in an issue: see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
