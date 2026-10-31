// The doorbell: a local process rings an agent for a turn in a thread, or in a new top-level post.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { LocalApiServer } from '../src/local-api/server.js'
import { doorbellRoute } from '../src/local-api/doorbell.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'agent-1'
const INT = 'int-s'
const CHANNEL = 'C-LEADS'
const TOKEN = 'a-local-token-of-enough-length'

async function world() {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    chatActions: 'talk',
    integrations: [
      {
        id: INT,
        platform: 'slack',
        core: {
          mode: 'direct',
          bindRules: [],
          mutedChannels: [],
          gated: false,
          sessionModes: [],
          externalChannels: [],
          decisions: { bindings: [], definitions: [] }
        },
        config: { botToken: 'x', appToken: 'y' }
      }
    ]
  })
  const conn = {
    postMessage: vi.fn(async () => '1700000000.000100'),
    getChannelHistory: vi.fn(async () => ({ messages: [], hasMore: false })),
    joinChannel: vi.fn(async () => undefined),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'leads', isPrivate: true })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u })),
    downloadFile: vi.fn(async () => null)
  }
  daemon.connByIntegration.set(INT, conn)
  const dispatch = vi.fn(async (_agent: string, _msg: unknown, _int: string, _w: unknown, _c: unknown, opts: any) => {
    await opts?.onAdmission?.({ accepted: true })
    return 'acp-1'
  })
  daemon.dispatch = dispatch
  return { daemon, store, conn, dispatch }
}

describe('doorbell', () => {
  it('posts at top level and runs the turn in the new thread', async () => {
    const w = await world()
    const reply = await w.daemon.ringDoorbell({
      agent: 'Butler',
      channel: CHANNEL,
      text: 'A new car to judge',
      post: 'New Lead: 2016 Camry'
    })
    expect(reply).toEqual({ status: 202, body: { channel: CHANNEL, thread: '1700000000.000100' } })
    expect(w.conn.postMessage.mock.calls[0]!.slice(0, 2)).toEqual([CHANNEL, 'New Lead: 2016 Camry'])
    const [agentId, msg, integrationId] = w.dispatch.mock.calls[0]!
    expect(agentId).toBe(AGENT)
    expect(integrationId).toBe(INT)
    expect(msg).toMatchObject({
      channel: CHANNEL,
      thread: '1700000000.000100',
      text: 'A new car to judge',
      source: 'system'
    })
    await w.store.close()
  })

  it('runs a turn in an existing thread without posting', async () => {
    const w = await world()
    const reply = await w.daemon.ringDoorbell({
      agent: AGENT,
      channel: CHANNEL,
      thread: '1690000000.000200',
      text: 'Seller wrote'
    })
    expect(reply.status).toBe(202)
    expect(w.conn.postMessage).not.toHaveBeenCalled()
    expect(w.dispatch.mock.calls[0]![1]).toMatchObject({ channel: CHANNEL, thread: '1690000000.000200', isDm: false })
    await w.store.close()
  })

  it('refuses an unknown agent and a turn the daemon does not admit', async () => {
    const w = await world()
    expect((await w.daemon.ringDoorbell({ agent: 'nobody', channel: CHANNEL, text: 'x' })).status).toBe(404)
    w.dispatch.mockImplementationOnce(async () => null)
    const refused = await w.daemon.ringDoorbell({ agent: AGENT, channel: CHANNEL, thread: '1.2', text: 'x' })
    expect(refused.status).toBe(409)
    await w.store.close()
  })
})

describe('local api server', () => {
  let server: LocalApiServer | undefined
  afterEach(async () => server?.close())

  it('needs the bearer token, validates the body, and binds loopback only', async () => {
    const ring = vi.fn(async () => ({ status: 202, body: { thread: 't' } }))
    server = new LocalApiServer({ port: 0, token: TOKEN, routes: [doorbellRoute(ring)] })
    const port = await server.start()
    const url = `http://127.0.0.1:${port}/v1/doorbell`
    const post = (body: unknown, token = TOKEN) =>
      fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    expect((await post({ agent: 'a', channel: 'C', text: 'hi' }, 'wrong')).status).toBe(401)
    expect((await post({ agent: 'a', channel: 'C' })).status).toBe(400)
    const ok = await post({ agent: 'a', channel: 'C', text: 'hi' })
    expect(ok.status).toBe(202)
    expect(await ok.json()).toEqual({ thread: 't' })
    expect(ring).toHaveBeenCalledWith({ agent: 'a', channel: 'C', text: 'hi' })
    const missing = await fetch(`http://127.0.0.1:${port}/v1/nope`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(missing.status).toBe(404)
  })
})
