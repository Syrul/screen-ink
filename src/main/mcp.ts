// The MCP server: Streamable HTTP on 127.0.0.1, stateless (a fresh server per request), bearer-token protected.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { screen } from 'electron'
import { z } from 'zod'
import { checkMarks } from '../shared/check'
import { drawShape } from '../shared/marks'
import * as canvas from './canvas'
import { capture, displayUnderCursor, screenAccess } from './capture'
import { INSTRUCTIONS, NARRATE } from './config'
import * as overlay from './overlay'
import { describe } from './sense'

export interface InkOptions {
  port: number
  token: string
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError })

function buildServer(): McpServer {
  const server = new McpServer({ name: 'screen-ink', version: '0.1.0' }, { instructions: `${INSTRUCTIONS} ${NARRATE}` })

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
