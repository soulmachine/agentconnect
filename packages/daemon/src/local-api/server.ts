import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/** What a route returns: an HTTP status and an optional JSON body. */
export interface LocalApiReply {
  status: number
  body?: unknown
}

/** One route; `path` segments starting with `:` are captured into `params`. */
export interface LocalApiRoute {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  handle(input: { params: Record<string, string>; body: unknown }): Promise<LocalApiReply>
}

const MAX_BODY_BYTES = 64 * 1024

function match(route: LocalApiRoute, method: string, path: string): Record<string, string> | undefined {
  if (route.method !== method) return undefined
  const want = route.path.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(got[i]!)
    else if (segment !== got[i]) return undefined
  }
  return params
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization ?? '')
  const want = Buffer.from(`Bearer ${token}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

function send(res: ServerResponse, reply: LocalApiReply): void {
  if (reply.body === undefined) return void res.writeHead(reply.status).end()
  res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body))
}

/** The daemon's loopback REST surface for processes on the same host, behind one bearer token. */
export class LocalApiServer {
  private server?: Server

  constructor(
    private readonly opts: {
      port: number
      token: string
      routes: LocalApiRoute[]
      log?: { warn(msg: string): void }
    }
  ) {}

  async start(): Promise<number> {
    const server = createServer((req, res) => void this.serve(req, res))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port, '127.0.0.1', () => resolve())
    })
    return (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!authorized(req, this.opts.token)) return send(res, { status: 401, body: { error: 'unauthorized' } })
      const path = new URL(req.url ?? '/', 'http://local').pathname
      for (const route of this.opts.routes) {
        const params = match(route, req.method ?? '', path)
        if (!params) continue
        let body: unknown
        try {
          body = await readJson(req)
        } catch (err) {
          return send(res, { status: 400, body: { error: (err as Error).message } })
        }
        return send(res, await route.handle({ params, body }))
      }
      send(res, { status: 404, body: { error: 'not found' } })
    } catch (err) {
      this.opts.log?.warn(`local api: ${req.method} ${req.url} failed: ${(err as Error).message}`)
      send(res, { status: 500, body: { error: 'internal error' } })
    }
  }
}
