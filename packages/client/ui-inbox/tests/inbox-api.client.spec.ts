/**
 * The inbox wire client: three same-origin paths at the ROOT of the e-server
 * origin (never under the page's `/_dsh/` prefix), the profile cookie as the
 * whole authentication, and every refusal shape folded into one result value.
 *
 * The URL assertions are the point of this suite: a request that names a
 * session id, or that lands under the page prefix, would be a different
 * contract from the one the server implements.
 */
import { describe, expect, it } from 'vitest'
import {
  createInboxApi, type FetchLike, INBOX_CLEAR_PATH, INBOX_LIST_PATH, INBOX_OPEN_PATH,
} from '../src/client/inbox-api.ts'

/** One recorded call plus the canned answer. */
interface Call {
  input: string
  init: RequestInit | undefined
}

/** A fetch double that answers one canned status/body and records what it saw. */
function stubFetch(status: number, body: unknown): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init })
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }
  return { calls, fetchImpl }
}

const listBody = {
  person: { id: 'person-1', name: 'Person One' },
  agents: [
    {
      agent: 'agent-a', name: 'Alpha', hasConversation: true,
      sessionId: 's-1', blank: false, lastActivityAt: 1792466828.2, running: false,
    },
    {
      agent: 'agent-b', name: 'Beta', hasConversation: false,
      sessionId: null, blank: true, lastActivityAt: null, running: true,
    },
  ],
}

describe('inbox api paths', () => {
  it('reads the list from the origin root, not the page prefix', async () => {
    const { calls, fetchImpl } = stubFetch(200, listBody)
    const outcome = await createInboxApi(fetchImpl).list()
    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe('/v1/browser/inbox')
    expect(calls[0]?.input).toBe(INBOX_LIST_PATH)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  it('posts the agent id to open and clear, and nothing else', async () => {
    const open = stubFetch(200, {
      agent: 'agent-a', sessionId: 's-1', created: true, blank: true, lastActivityAt: null,
    })
    expect((await createInboxApi(open.fetchImpl).open('agent-a')).ok).toBe(true)
    expect(open.calls[0]?.input).toBe('/v1/browser/inbox/open')
    expect(open.calls[0]?.input).toBe(INBOX_OPEN_PATH)
    expect(open.calls[0]?.init?.method).toBe('POST')
    expect(open.calls[0]?.init?.credentials).toBe('same-origin')
    expect(open.calls[0]?.init?.body).toBe(JSON.stringify({ agent: 'agent-a' }))

    const clear = stubFetch(200, {
      agent: 'agent-a', hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true,
    })
    expect((await createInboxApi(clear.fetchImpl).clear('agent-a')).ok).toBe(true)
    expect(clear.calls[0]?.input).toBe('/v1/browser/inbox/clear')
    expect(clear.calls[0]?.input).toBe(INBOX_CLEAR_PATH)
    expect(clear.calls[0]?.init?.body).toBe(JSON.stringify({ agent: 'agent-a' }))
  })
})

describe('inbox api payloads', () => {
  it('keeps the server order and the nullable fields verbatim', async () => {
    const { fetchImpl } = stubFetch(200, listBody)
    const outcome = await createInboxApi(fetchImpl).list()
    expect(outcome).toEqual({
      ok: true,
      value: {
        person: { id: 'person-1', name: 'Person One' },
        agents: [
          {
            agent: 'agent-a', name: 'Alpha', hasConversation: true,
            sessionId: 's-1', blank: false, lastActivityAt: 1792466828.2, running: false,
          },
          {
            agent: 'agent-b', name: 'Beta', hasConversation: false,
            sessionId: null, blank: true, lastActivityAt: null, running: true,
          },
        ],
      },
    })
  })

  it('reads a clear answer that says the conversation survived', async () => {
    const { fetchImpl } = stubFetch(200, {
      agent: 'agent-a', hasConversation: true, sessionId: 's-1', blank: false, lastActivityAt: 12, cleared: false,
    })
    const outcome = await createInboxApi(fetchImpl).clear('agent-a')
    expect(outcome.ok && outcome.value.cleared).toBe(false)
    expect(outcome.ok && outcome.value.sessionId).toBe('s-1')
  })

  it('refuses to invent a row the server did not spell out', async () => {
    const rows = [
      { person: { id: 'p', name: 'P' }, agents: [{ agent: 'a', name: 'A' }] },
      { person: { id: 'p', name: 'P' }, agents: [{ ...listBody.agents[0], name: 7 }] },
      { person: { id: 'p', name: 'P' } },
      { person: { id: 'p' }, agents: [] },
      { agents: [] },
      [],
      null,
    ]
    for (const body of rows) {
      const { fetchImpl } = stubFetch(200, body)
      const outcome = await createInboxApi(fetchImpl).list()
      expect(outcome).toEqual({ ok: false, status: 200, code: 'malformed' })
    }
  })

  it('refuses an unreadable open or clear body', async () => {
    const bodies = [
      { agent: 'agent-a' },
      { agent: 'agent-a', sessionId: 5, created: true, blank: true, lastActivityAt: null },
      'not-json-object',
    ]
    for (const body of bodies) {
      const open = stubFetch(200, body)
      expect((await createInboxApi(open.fetchImpl).open('agent-a')).ok).toBe(false)
      const clear = stubFetch(200, body)
      expect((await createInboxApi(clear.fetchImpl).clear('agent-a')).ok).toBe(false)
    }
  })
})

describe('inbox api failures', () => {
  it('maps every status the contract names', async () => {
    const cases: [number, string][] = [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'notFound'],
      [409, 'conflict'],
      [500, 'unexpected'],
      [502, 'hostUnavailable'],
      [503, 'unavailable'],
    ]
    for (const [status, code] of cases) {
      const { fetchImpl } = stubFetch(status, { detail: 'nope' })
      expect(await createInboxApi(fetchImpl).list()).toEqual({ ok: false, status, code })
    }
  })

  it('folds a rejected transport into a retryable failure instead of throwing', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('Failed to parse URL'))
    expect(await createInboxApi(fetchImpl).list()).toEqual({ ok: false, status: 0, code: 'transport' })
  })

  it('reports an unreadable 200 body as malformed rather than throwing', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }))
    expect(await createInboxApi(fetchImpl).list()).toEqual({ ok: false, status: 200, code: 'malformed' })
  })

  it('gives up on a host that never answers', async () => {
    const fetchImpl: FetchLike = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    expect(await createInboxApi(fetchImpl, 5).list()).toEqual({ ok: false, status: 0, code: 'timeout' })
  })
})
