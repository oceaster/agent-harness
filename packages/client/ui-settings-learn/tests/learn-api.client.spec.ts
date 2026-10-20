/**
 * The learn wire client: ONE same-origin path at the ROOT of the e-server
 * origin (never under the page's own `/_dsh/` prefix), the profile cookie as
 * the whole authentication, and every refusal shape folded into one result
 * value.
 *
 * The failure cases are the point of this suite. e-server answers refusals with
 * FastAPI's `{"detail": ...}` — a string for `HTTPException(500, "…")` and an
 * object for `HTTPException(502, {error, code, message})` — and that sentence is
 * what a person needs on screen, so it is carried through verbatim instead of
 * being flattened into a generic code. The payload fixtures are the real
 * answers, so a drift in the wire shape fails here rather than in a browser.
 */
import { describe, expect, it } from 'vitest'
import {
  createLearnApi, failureDetail, LEARN_PATH, type FetchLike, type LearnFailureCode,
} from '../src/client/learn-api.ts'
import { LEARN_PAYLOAD } from './fixture/learn-payload.client.ts'

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

/** A fetch double answering a body that is not JSON at all (a proxy error page). */
const htmlFetch: FetchLike = () => Promise.resolve(new Response('<html>502 Bad Gateway</html>', {
  status: 502,
  headers: { 'content-type': 'text/html' },
}))

/** e-server's own sentences, verbatim. */
const INCOMPLETE_GUIDES = 'The agent guides are incomplete: no guide in context/agent-guides.json'
  + ' for the dexter agent, which this person may use. Ask Owen to fix them'
const GUEST_REFUSAL = 'DSH is unavailable to Guest'
const RESTARTING = 'The Agent Harness is restarting; try again in a moment'

/** The code each status maps to, so a drifted status table fails one row at a time. */
const STATUS_CODES: readonly (readonly [number, LearnFailureCode])[] = [
  [401, 'unauthenticated'],
  [403, 'forbidden'],
  [404, 'notFound'],
  [409, 'conflict'],
  [500, 'serverError'],
  [502, 'hostUnavailable'],
  [503, 'unavailable'],
  [418, 'unexpected'],
]

/** A structured 502 body: the nested RPC refusal e-server wraps in `detail`. */
const HOST_REFUSAL = {
  detail: { error: 'harness-refused', method: 'agentPreset.list', code: 'unknown-command', message: 'agentPreset.list is not available' },
}

describe('learn api request', () => {
  it('reads the origin root, not the page prefix', async () => {
    const { calls, fetchImpl } = stubFetch(200, LEARN_PAYLOAD)

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe('/v1/browser/learn')
    expect(calls[0]?.input).toBe(LEARN_PATH)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  it('returns the payload the server sent, unchanged', async () => {
    const { fetchImpl } = stubFetch(200, LEARN_PAYLOAD)

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toStrictEqual({ ok: true, value: LEARN_PAYLOAD })
  })

  it('keeps every agent and every section the server ordered', async () => {
    const { fetchImpl } = stubFetch(200, LEARN_PAYLOAD)

    const outcome = await createLearnApi(fetchImpl).read()

    /* v8 ignore next -- the fixture always parses; the assertion above owns that */
    if (!outcome.ok) throw new Error('the fixture must parse')
    expect(outcome.value.agents.map(agent => agent.agent)).toStrictEqual(['delta', 'darwin', 'diana'])
    expect(outcome.value.agents.map(agent => agent.sections.length)).toStrictEqual([5, 5, 5])
    // The section ids differ per agent; nothing here normalizes them.
    expect(outcome.value.agents[0]?.sections.map(section => section.id)).toStrictEqual([
      'what-it-is-for', 'how-it-works', 'what-it-will-not-do', 'how-to-use-it', 'waiting-and-workers',
    ])
    expect(outcome.value.agents[2]?.sections.at(-1)?.id).toBe('memory-and-privacy')
  })

  it('reads an authenticated profile with no agents as a real empty answer', async () => {
    const { fetchImpl } = stubFetch(200, { person: { id: 'guest', name: 'Guest' }, agents: [] })

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toStrictEqual({ ok: true, value: { person: { id: 'guest', name: 'Guest' }, agents: [] } })
  })
})

describe('learn api failures', () => {
  it('maps every status to the code the section has copy for', async () => {
    for (const [status, code] of STATUS_CODES) {
      const { fetchImpl } = stubFetch(status, { detail: 'refused' })

      const outcome = await createLearnApi(fetchImpl).read()

      expect(outcome).toMatchObject({ ok: false, status, code })
    }
  })

  it('carries the 500 sentence that names the missing guide', async () => {
    const { fetchImpl } = stubFetch(500, { detail: INCOMPLETE_GUIDES })

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toMatchObject({ ok: false, status: 500, code: 'serverError', detail: INCOMPLETE_GUIDES })
  })

  it('carries the Guest refusal sentence', async () => {
    const { fetchImpl } = stubFetch(403, { detail: GUEST_REFUSAL })

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toMatchObject({ ok: false, status: 403, code: 'forbidden', detail: GUEST_REFUSAL })
  })

  it('carries the restarting sentence of a 503', async () => {
    const { fetchImpl } = stubFetch(503, { detail: RESTARTING })

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toMatchObject({ ok: false, status: 503, code: 'unavailable', detail: RESTARTING })
  })

  it('reads the message out of a structured detail', async () => {
    const { fetchImpl } = stubFetch(502, HOST_REFUSAL)

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toMatchObject({
      ok: false, status: 502, code: 'hostUnavailable', detail: 'agentPreset.list is not available',
    })
  })

  it('reports a refusal with nothing readable as a failure with no detail', async () => {
    const { fetchImpl } = stubFetch(502, { detail: { code: 'unknown-command' } })

    const outcome = await createLearnApi(fetchImpl).read()

    expect(outcome).toMatchObject({ ok: false, status: 502, code: 'hostUnavailable', detail: null })
  })

  it('answers a non-JSON error body with the status, not a parse throw', async () => {
    const outcome = await createLearnApi(htmlFetch).read()

    expect(outcome).toMatchObject({ ok: false, status: 502, code: 'hostUnavailable', detail: null })
  })

  it('answers a rejected transport as a retryable failure with no status', async () => {
    const outcome = await createLearnApi(() => Promise.reject(new TypeError('offline'))).read()

    expect(outcome).toStrictEqual({ ok: false, status: 0, code: 'transport', detail: null })
  })

  it('answers a read that outlives its budget as a timeout', async () => {
    const fetchImpl: FetchLike = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })

    const outcome = await createLearnApi(fetchImpl, 5).read()

    expect(outcome).toStrictEqual({ ok: false, status: 0, code: 'timeout', detail: null })
  })
})

describe('learn api payload validation', () => {
  /** The real payload with one section's body removed: the guide is not complete. */
  const SECTION_WITHOUT_BODY = structuredClone(LEARN_PAYLOAD) as unknown as {
    agents: { sections: Record<string, unknown>[] }[]
  }
  delete SECTION_WITHOUT_BODY.agents[0]!.sections[2]!['body']

  /** The real payload with the last section of the last agent dropped entirely. */
  const DROPPED_SECTIONS = structuredClone(LEARN_PAYLOAD) as unknown as {
    agents: { sections: unknown[] }[]
  }
  DROPPED_SECTIONS.agents[2]!.sections.pop()

  /** Bodies whose shape the browser must refuse rather than half-render. */
  const INVALID: readonly (readonly [string, unknown])[] = [
    ['a non-object body', ['agents']],
    ['no person', { agents: [] }],
    ['a person without a name', { person: { id: 'owen' }, agents: [] }],
    ['a person with an empty id', { person: { id: '', name: 'Owen' }, agents: [] }],
    ['no agents array', { person: { id: 'owen', name: 'Owen' }, agents: {} }],
    ['an agent that is not an object', { person: { id: 'owen', name: 'Owen' }, agents: ['delta'] }],
    ['an agent without a summary', {
      person: { id: 'owen', name: 'Owen' },
      agents: [{ agent: 'delta', name: 'Delta', enabled: true, sections: [] }],
    }],
    ['an agent whose enabled flag is a string', {
      person: { id: 'owen', name: 'Owen' },
      agents: [{ agent: 'delta', name: 'Delta', enabled: 'yes', summary: 's', sections: [] }],
    }],
    ['an agent whose sections are not an array', {
      person: { id: 'owen', name: 'Owen' },
      agents: [{ agent: 'delta', name: 'Delta', enabled: true, summary: 's', sections: {} }],
    }],
    ['a section that is not an object', {
      person: { id: 'owen', name: 'Owen' },
      agents: [{ agent: 'delta', name: 'Delta', enabled: true, summary: 's', sections: ['what-it-is-for'] }],
    }],
    ['a section without a title', {
      person: { id: 'owen', name: 'Owen' },
      agents: [{ agent: 'delta', name: 'Delta', enabled: true, summary: 's', sections: [{ id: 'a', body: 'b' }] }],
    }],
    ['a section without a body', SECTION_WITHOUT_BODY],
  ]

  it('refuses a payload with a section missing instead of rendering it as complete', async () => {
    for (const [label, body] of INVALID) {
      const { fetchImpl } = stubFetch(200, body)

      const outcome = await createLearnApi(fetchImpl).read()

      expect({ label, outcome }).toStrictEqual({ label, outcome: { ok: false, status: 200, code: 'malformed', detail: null } })
    }
  })

  it('accepts a payload whose section list is shorter than the last one seen', async () => {
    const { fetchImpl } = stubFetch(200, DROPPED_SECTIONS)

    const outcome = await createLearnApi(fetchImpl).read()

    // A section the server stopped sending is gone, never an error: the tab
    // renders what arrives, and only a broken section is a failure.
    expect(outcome.ok).toBe(true)
    /* v8 ignore next -- asserted above */
    if (!outcome.ok) return
    expect(outcome.value.agents[2]?.sections.map(section => section.id)).toStrictEqual([
      'what-it-is-for', 'how-it-works', 'what-it-will-not-do', 'how-to-use-it',
    ])
  })
})

describe('failureDetail', () => {
  it('reads a string detail', () => {
    expect(failureDetail({ detail: GUEST_REFUSAL })).toBe(GUEST_REFUSAL)
  })

  it('reads the sentence out of a structured detail, most specific field first', () => {
    expect(failureDetail({ detail: { message: 'm', detail: 'd', error: 'e' } })).toBe('m')
    expect(failureDetail({ detail: { detail: 'd', error: 'e' } })).toBe('d')
    expect(failureDetail({ detail: { error: 'e' } })).toBe('e')
  })

  it('reads nothing from a body with no readable sentence', () => {
    expect(failureDetail({ detail: '   ' })).toBeNull()
    expect(failureDetail({ detail: { code: 'unknown-command' } })).toBeNull()
    expect(failureDetail({ detail: null })).toBeNull()
    expect(failureDetail({})).toBeNull()
    expect(failureDetail(undefined)).toBeNull()
    expect(failureDetail('DSH is unavailable to Guest')).toBeNull()
  })
})
