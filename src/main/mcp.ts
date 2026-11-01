// The MCP server: Streamable HTTP on 127.0.0.1, stateless (a fresh server per request), bearer-token protected.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { screen } from 'electron'
import { z } from 'zod'
import { drawShape } from '../shared/marks'
import { capture, displayUnderCursor, screenAccess } from './capture'
import * as overlay from './overlay'

export interface InkOptions {
  port: number
  token: string
  ink: string
}

// The last screenshot fixes the display and coordinate space `draw` uses. It outlives requests on purpose.
let last: { displayId: number; width: number; height: number } | null = null

const INSTRUCTIONS = [
  "screen-ink lets you look at the user's screen and draw on it, like a friend pointing with a pen.",
  "Call screenshot, then draw in that screenshot's coordinates.",
  'Point at things instead of covering them: ring or frame the target, put a short label pill beside it, number steps with badges, and arrow from your words to the target.',
  'Use the fewest marks that answer, say the rest in the caption, and clear when the user is done.',
].join(' ')

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError })

function buildServer(opts: InkOptions): McpServer {
  const server = new McpServer({ name: 'screen-ink', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'screenshot',
    {
      title: 'Look at the screen',
      description:
        "Takes a screenshot of one display (without screen-ink's own marks) and makes it the canvas for draw. " +
        'Returns the image and its size in units: draw coordinates use the same units.',
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
        last = { displayId: d.id, width: shot.width, height: shot.height }
        return {
          content: [
            { type: 'image' as const, data: shot.jpeg.toString('base64'), mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text: `Display ${d.id}${d.label ? ` (${d.label})` : ''}: ${shot.width}×${shot.height} units, x right, y down, origin top-left. One unit is ${shot.ppu.toFixed(2)} screen points.`,
            },
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
        'whenever the screen may have changed. Marks animate in order like a pen. The drawing replaces the current one unless append is true.',
      inputSchema: drawShape,
    },
    async args => {
      if (!last) return text('Call screenshot first: draw uses its coordinates.', true)
      const d = screen.getAllDisplays().find(x => x.id === last!.displayId)
      if (!d) return text('The display from the last screenshot is gone. Take a new screenshot.', true)
      await overlay.draw(d, { ...args, ppu: d.size.width / last.width, ink: opts.ink })
      const fade = args.fadeAfter ? `, fading ${args.fadeAfter}s after it finishes` : ', staying until cleared'
      return text(`Drew ${args.marks.length} mark${args.marks.length === 1 ? '' : 's'} on display ${d.id}${fade}.`)
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
    const server = buildServer(opts)
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
