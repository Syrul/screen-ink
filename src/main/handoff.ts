// Handing a task to Claude Code. An answer's "Do it" button opens a Terminal window running the user's `claude` with
// the task, in the project's folder when the answer named one inside their home (else home). It is an ordinary
// interactive session: the user watches it work and approves its steps as usual. It reaches screen-ink through an MCP
// config written beside the token, and is asked to keep the user posted with the progress tool, a checklist card in
// the corner of the screen.
import { app, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as settings from './settings'

const PROMPT = `You were started from screen-ink, which draws on the user's screen, to do the task you are given while they
watch. Keep them posted with screen-ink's progress tool: call it first with your plan as a few short steps, again as each
step starts, finishes or fails, until every step is done or failed. Ask before anything that can't be undone.`

let server: { url: string; token: string } | null = null

/** Where the hand-off's Claude Code finds screen-ink. Call once, at startup. */
export function init(s: { url: string; token: string }): void {
  server = s
}

/** The folder to work in: the one named, if it is a folder in the user's home; else home. */
function folderFor(folder?: string): string {
  const home = os.homedir()
  if (!folder) return home
  const p = path.resolve(folder.replace(/^~(?=$|\/)/, home))
  try {
    if ((p === home || p.startsWith(home + path.sep)) && fs.statSync(p).isDirectory()) return p
  } catch {}
  return home
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** Opens Claude Code on `task` in a new Terminal window. Resolves whether it could (macOS only, for now). */
export async function start(task: string, folder?: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !server || !task.trim()) return false
  const dir = path.join(app.getPath('userData'), 'handoff')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const mcp = path.join(dir, 'mcp.json')
  const config = { mcpServers: { 'screen-ink': { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }
  fs.writeFileSync(mcp, JSON.stringify(config), { mode: 0o600 })
  const prompt = path.join(dir, 'prompt.txt')
  fs.writeFileSync(prompt, PROMPT, { mode: 0o600 })
  // The task travels in a file, never through the shell's parsing, and the files go once read.
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const taskFile = path.join(dir, `${id}.txt`)
  const script = path.join(dir, `${id}.command`)
  fs.writeFileSync(taskFile, task.trim(), { mode: 0o600 })
  const lines = [
    '#!/bin/zsh -l',
    `cd ${quote(folderFor(folder))} || exit 1`,
    `task=$(cat ${quote(taskFile)}); rm -f ${quote(taskFile)} ${quote(script)}`,
    `exec ${quote(settings.get().claude)} --mcp-config ${quote(mcp)} --allowedTools mcp__screen-ink__progress --append-system-prompt "$(cat ${quote(prompt)})" "$task"`,
  ]
  fs.writeFileSync(script, lines.join('\n') + '\n', { mode: 0o700 })
  return (await shell.openPath(script)) === '' // Terminal runs .command files
}
