// The MCP server: Streamable HTTP on 127.0.0.1, stateless (a fresh server per request), bearer-token protected.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { screen } from 'electron'
import { z } from 'zod'
import { BUILD_MOVES } from '../shared/build'
import { checkMarks } from '../shared/check'
import { drawShape, type Box } from '../shared/marks'
import * as canvas from './canvas'
import { capture, displayUnderCursor, screenAccess } from './capture'
import { scrollSchema } from './answer'
import * as builds from './builds'
import { INSTRUCTIONS, NARRATE } from './config'
import * as lessons from './lessons'
import * as overlay from './overlay'
import * as sense from './sense'
import { describe } from './sense'

export interface InkOptions {
  port: number
  token: string
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError })
const PROGRESS = 'While you work on a task the user is waiting on, keep them posted with progress: it needs no screenshot.'
const PROGRESS_FADE = 20 // seconds the checklist stays once every step is done or failed

function buildServer(): McpServer {
  const server = new McpServer({ name: 'screen-ink', version: '0.1.0' }, { instructions: `${INSTRUCTIONS} ${NARRATE} ${PROGRESS}` })

  server.registerTool(
    'screenshot',
    {
      title: 'Look at the screen',
      description:
        "Takes a screenshot of one display (without screen-ink's own marks) and makes it the canvas for draw. " +
        'Returns the image, its size in units (draw coordinates use the same units), and a numbered list of the ' +
        'buttons, menus, fields and text on screen: name one by its id in a mark to land on it exactly.',
      inputSchema: {
        display: z.enum(['cursor', 'primary']).optional().describe('Which display: the one under the mouse (default) or the main one.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ display }) => {
      if (screenAccess() === 'denied') {
        return text('Screen Recording is off for screen-ink. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch screen-ink.', true)
      }
      const d = display === 'primary' ? screen.getPrimaryDisplay() : displayUnderCursor()
      try {
        const shot = await capture(d)
        canvas.remember(shot)
        const elements = describe(await shot.elements)
        return {
          content: [
            { type: 'image' as const, data: shot.jpeg.toString('base64'), mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text: `Display ${d.id}${d.label ? ` (${d.label})` : ''}: ${shot.width}×${shot.height} units, x right, y down, origin top-left. One unit is ${shot.ppu.toFixed(2)} screen points.`,
            },
            ...(elements ? [{ type: 'text' as const, text: elements }] : []),
          ],
        }
      } catch (e) {
        return text(`Screenshot failed: ${(e as Error).message}`, true)
      }
    },
  )

  server.registerTool(
    'draw',
    {
      title: 'Draw on the screen',
      description:
        'Draws hand-drawn marks over the display from the last screenshot, in its coordinates. Call screenshot first, and again ' +
        'whenever the screen may have changed. Marks animate in order like a pen. The drawing replaces the current one unless append is true. ' +
        'Give a mark an id to change it later: with append, a mark with the same id replaces it, and remove takes marks away by id.',
      inputSchema: drawShape,
    },
    async args => {
      let drawn
      try {
        drawn = await canvas.draw(args)
      } catch (e) {
        return text((e as Error).message, true)
      }
      const { display: d, drawn: n, missing, failed } = drawn
      const fade = args.fadeAfter ? `, fading ${args.fadeAfter}s after it finishes` : ', staying until cleared'
      const skipped = missing.length ? ` Left out marks on ${missing.join(', ')}: the last screenshot has no such element.` : ''
      const problems = checkMarks(args.marks)
      const check = problems.length ? `\nThe figure won't work as meant: ${problems.join(' ')} Fix it and draw it again.` : ''
      const photos = failed.length ? ` Left out ${failed.length} photo${failed.length === 1 ? '' : 's'}: ${failed.join('; ')}` : ''
      return text(`Drew ${n} mark${n === 1 ? '' : 's'} on display ${d.id}${fade}.${skipped}${photos}${check}`)
    },
  )

  server.registerTool(
    'scroll',
    {
      title: 'Scroll',
      description:
        'Scrolls the page, list or panel at a spot on the display from the last screenshot, to bring what is out of view into it ' +
        '(further down a web page, say). It clears the drawing, which no longer lines up; take a new screenshot to see the result. ' +
        "screen-ink's pointer shows the scroll. Needs Accessibility.",
      inputSchema: scrollSchema.shape,
    },
    async ({ direction, by, at }) => {
      try {
        const { display, point, ppu, size } = await canvas.spot(at as Box | string | undefined)
        const vertical = direction === 'down' || direction === 'up'
        await overlay.point([point[0] - display.bounds.x, point[1] - display.bounds.y], { scroll: direction })
        if (!(await sense.scroll(point, direction, (by ?? 0.7 * (vertical ? size[1] : size[0])) * ppu))) {
          return text('Scrolling needs Accessibility for screen-ink: System Settings → Privacy & Security → Accessibility.', true)
        }
        overlay.clear(true)
        return text(`Scrolled ${direction}. Take a new screenshot to see where it landed.`)
      } catch (e) {
        return text((e as Error).message, true)
      }
    },
  )

  server.registerTool(
    'progress',
    {
      title: 'Show progress',
      description:
        "Shows a checklist in the corner of the user's screen to keep them posted on a task while you work: call it with your " +
        'plan as a few short steps, then again with the whole list whenever a step starts, finishes or fails. It needs no screenshot, ' +
        'sits over whatever else is drawn, and fades a little after every step is done or failed.',
      inputSchema: {
        title: z.string().max(60).optional().describe('The task, in a few words.'),
        steps: z
          .array(z.object({ text: z.string().max(120), state: z.enum(['todo', 'doing', 'done', 'failed']).optional().describe('Default: todo.') }))
          .min(1)
          .max(12),
      },
    },
    async ({ title, steps }) => {
      const finished = steps.every(s => s.state === 'done' || s.state === 'failed')
      const d = await canvas.add([{ kind: 'steps', id: 'progress', title, items: steps }], finished ? PROGRESS_FADE : undefined)
      return text(`Showing ${steps.length} step${steps.length === 1 ? '' : 's'} on display ${d.id}${finished ? `, fading in ${PROGRESS_FADE}s` : ''}.`)
    },
  )

  server.registerTool(
    'save_lesson',
    {
      title: 'Keep this drawing',
      description: 'Saves the last drawing (with what was added to it) as a lesson the user can show again from the menu, or you with show_lesson.',
      inputSchema: { title: z.string().max(80).optional().describe('What it teaches. Default: from its own words.') },
    },
    async ({ title }) => {
      try {
        const l = lessons.save(title)
        return l ? text(`Saved "${l.title}" as lesson ${l.id}.`) : text('Nothing has been drawn yet.', true)
      } catch (e) {
        return text((e as Error).message, true)
      }
    },
  )

  server.registerTool(
    'lessons',
    { title: 'List lessons', description: 'Lists the saved lessons, newest first.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      const all = lessons.list()
      return text(all.length ? all.map(l => `${l.id}: ${l.title} (${l.at.slice(0, 10)})`).join('\n') : 'No lessons saved yet.')
    },
  )

  server.registerTool(
    'show_lesson',
    {
      title: 'Show a lesson',
      description: 'Draws a saved lesson again, scaled to the display, replacing what is drawn. It needs no screenshot.',
      inputSchema: { id: z.string().max(40).describe('From lessons.') },
    },
    async ({ id }) => ((await canvas.showLesson(id)) ? text('Showing it.') : text(`There is no lesson ${id}.`, true)),
  )

  server.registerTool(
    'build',
    {
      title: 'Build along with instructions',
      description:
        "Shows a LEGO set's building instructions (fetched from LEGO), or an instructions PDF on this Mac, a step at a time in a " +
        'panel on the side of the screen that reads each step out; the user moves on with its Next button or by saying "next" in ' +
        'the bar. Where LDraw\'s library has a 3D model of the set, each step shows in 3D too (the model so far, the new parts ' +
        'dropping in); give model for a set it has none of. Instructions opened before go back to where the user got to. ' +
        'With go or step alone, moves the ones open. Returns what is showing. It needs no screenshot.',
      inputSchema: {
        set: z.string().regex(/^\d{3,7}(-\d{1,2})?$/).optional().describe('A LEGO set number, like 60285.'),
        file: z.string().max(1000).optional().describe('Or an instructions PDF in the home folder.'),
        step: z.number().int().min(0).max(9999).optional().describe('The step to show. Default: where the user got to.'),
        go: z
          .enum(BUILD_MOVES)
          .optional()
          .describe('Moves the instructions open: the next or previous step, this one read again, the panel put away, or the step shown in 3D or as the page.'),
        model: z.string().max(1000).optional().describe('An LDraw model of the set (.ldr or .mpd) in the home folder, to show the steps of the instructions open in 3D.'),
      },
    },
    async ({ set, file, step, go, model }) => {
      try {
        if (set || file) {
          const shown = await builds.open({ set, file }, step)
          return text(model ? await builds.useModel(model) : shown)
        }
        if (model) return text(await builds.useModel(model))
        if (step === undefined && !go) return text(builds.where())
        const moved = await builds.go(step ?? go!)
        return moved ? text(moved) : text(builds.active() ? `There is no step ${step}.` : 'No instructions are open: give a set or file.', true)
      } catch (e) {
        return text(`Couldn't ${model && !set && !file ? 'use that model' : 'open the instructions'}: ${(e as Error).message}`, true)
      }
    },
  )

  server.registerTool(
    'clear',
    { title: 'Clear the screen', description: 'Erases everything screen-ink has drawn.', inputSchema: {} },
    async () => {
      overlay.clear()
      return text('Cleared.')
    },
  )

  return server
}

function reply(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function readBody(req: http.IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startMcp(opts: InkOptions): http.Server {
  const allowedHosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]
  const httpServer = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    if (pathname !== '/mcp') return reply(res, 404, 'Not found')
    // It can see the screen, so only local, non-browser clients holding the token get in.
    if (req.headers.origin) return reply(res, 403, 'Browsers may not call screen-ink')
    if (req.headers.authorization !== `Bearer ${opts.token}`) return reply(res, 401, 'Missing or wrong bearer token')
    if (req.method !== 'POST') return reply(res, 405, 'Method not allowed: this server is stateless')

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return reply(res, 400, 'Body must be JSON')
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      if (!res.headersSent) reply(res, 500, (e as Error).message)
    }
  })
  httpServer.listen(opts.port, '127.0.0.1')
  return httpServer
}
