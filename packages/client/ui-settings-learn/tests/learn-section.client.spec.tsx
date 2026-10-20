// @vitest-environment jsdom
/**
 * LearnSection: what a person sees, against the payload e-server actually
 * answers.
 *
 * The suite feeds props directly (a driven store plus the injected callbacks)
 * for the six states the ticket names — loaded, loading, failed with the
 * server's own detail, retry, a roster with no agents, and a refused profile —
 * and then runs two of them through the REAL wire client and controller, because
 * a component test over a hand-written snapshot cannot show that a `detail`
 * sentence travels from an HTTP body to the screen.
 *
 * The loaded assertions are the anti-hardcoding ones: every agent, every section
 * title and every section body comes from the fixture, including the section
 * only one agent carries (`waiting-and-workers`, `waiting-and-handoff`,
 * `memory-and-privacy`). A hardcoded section set would have to drop one.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createLearnApi, type FetchLike } from '../src/client/learn-api.ts'
import { LearnController, type LearnState } from '../src/client/learn-controller.ts'
import { LearnSection, paragraphs } from '../src/client/LearnSection.tsx'
import type { LearnSectionProps } from '../src/client/slots.ts'
import { en } from '../src/client/locales.ts'
import { LEARN_PAYLOAD } from './fixture/learn-payload.client.ts'

afterEach(cleanup)

const t: LearnSectionProps['t'] = makeTranslate(en, commonZh)

/** e-server's own sentences, verbatim. */
const GUEST_REFUSAL = 'DSH is unavailable to Guest'
const INCOMPLETE_GUIDES = 'The agent guides are incomplete: no guide in context/agent-guides.json'
  + ' for the dexter agent, which this person may use. Ask Owen to fix them'
const RESTARTING = 'The Agent Harness is restarting; try again in a moment'

/** The section's own words, as the deployed dictionaries render them. */
const COPY = makeTranslate(en)

/** The ready snapshot: the real payload, rendered as the tab ships. */
const READY: LearnState = {
  status: 'ready',
  person: LEARN_PAYLOAD.person,
  agents: LEARN_PAYLOAD.agents,
  failure: null,
}

/**
 * Render the section over a fixed snapshot with a spy `load`.
 * @param state - the snapshot fields to override.
 * @returns the store, the load spy, and the rendered container.
 */
function renderSection(state: Partial<LearnState> = {}) {
  const store = createSnapshotStore<LearnState>({ ...READY, ...state })
  const load = vi.fn()
  const props = {
    close: vi.fn(),
    useLearn: bindSnapshotSelector(store),
    load,
    t,
  } as unknown as LearnSectionProps
  const view = render(<LearnSection {...props} />)
  return { store, load, view }
}

/**
 * Render the section over the REAL wire client and controller, so the payload
 * travels the same route it takes in a browser.
 * @param answers - one `fetch` answer per read, in order (the last repeats).
 * @returns the controller and the number of requests the client made.
 */
async function renderLive(answers: readonly (() => Response)[]) {
  const requests: number[] = []
  const fetchImpl: FetchLike = () => {
    const answer = answers[Math.min(requests.length, answers.length - 1)]!
    requests.push(requests.length)
    return Promise.resolve(answer())
  }
  const controller = new LearnController({ api: createLearnApi(fetchImpl) })
  const props = {
    close: vi.fn(),
    useLearn: bindSnapshotSelector(controller.store),
    load: () => { void controller.load() },
    t,
  } as unknown as LearnSectionProps
  const view = render(<LearnSection {...props} />)
  return { controller, requests, view }
}

/** A JSON answer of one status. */
function answer(status: number, body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('the loaded sheet', () => {
  it('renders every agent the server sent, in the server order', () => {
    const { view } = renderSection()

    expect(screen.getByTestId('ui-learn-sheet')).toBeTruthy()
    const articles = [...view.container.querySelectorAll('article')]
    expect(articles.map(article => article.dataset['testid'])).toStrictEqual([
      'ui-learn-agent-delta', 'ui-learn-agent-darwin', 'ui-learn-agent-diana',
    ])
    expect(articles.map(article => article.querySelector('h3')?.textContent)).toStrictEqual([
      'Delta', 'Darwin', 'Diana',
    ])
  })

  it('names the person whose roster this is', () => {
    renderSection()

    expect(screen.getByTestId('ui-learn-person').textContent).toBe('Guides for Owen')
  })

  it('renders every section of every guide, in order, including the one only that agent carries', () => {
    renderSection()

    for (const agent of LEARN_PAYLOAD.agents) {
      const block = screen.getByTestId(`ui-learn-agent-${agent.agent}`)
      // The headings are the server's own words; the tab adds none of its own.
      const titles = [...block.querySelectorAll('dt')].map(node => node.textContent)
      expect(titles).toStrictEqual(agent.sections.map(section => section.title))
    }
    // Three different rosters, three different last sections: a hardcoded
    // section set would silently drop whichever one it did not know.
    expect(screen.getByText('Waiting, workers and branches')).toBeTruthy()
    expect(screen.getByText('Waiting and handoff')).toBeTruthy()
    expect(screen.getByText('Memory and privacy')).toBeTruthy()
  })

  it('renders the summary and splits a body into its paragraphs', () => {
    renderSection()

    const delta = screen.getByTestId('ui-learn-agent-delta')
    expect(within(delta).getByText(LEARN_PAYLOAD.agents[0]!.summary)).toBeTruthy()
    const section = screen.getByTestId('ui-learn-delta-what-it-is-for')
    const paragraphsOf = section.querySelectorAll('p')
    expect(paragraphsOf).toHaveLength(3)
    expect(paragraphsOf[0]?.textContent).toBe(paragraphs(LEARN_PAYLOAD.agents[0]!.sections[0]!.body)[0])
  })

  it('marks a guide the deployment cannot run', () => {
    renderSection({ agents: [{ ...LEARN_PAYLOAD.agents[0]!, enabled: false }] })

    expect(within(screen.getByTestId('ui-learn-agent-delta')).getByText(COPY('agent.disabled'))).toBeTruthy()
  })

  it('reads once when the tab first renders, and no more', async () => {
    const { load } = renderSection({ status: 'loading', person: null, agents: [] })

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    await act(async () => { await Promise.resolve() })
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('the four states', () => {
  it('says it is loading, and nothing else', () => {
    renderSection({ status: 'loading', person: null, agents: [] })

    expect(screen.getByTestId('ui-learn-loading').textContent).toBe(COPY('state.loading'))
    expect(screen.queryByTestId('ui-learn-sheet')).toBeNull()
    expect(screen.queryByTestId('ui-learn-retry')).toBeNull()
  })

  it('states a failed read with the sentence the server sent', () => {
    renderSection({
      status: 'error', person: null, agents: [],
      failure: { ok: false, status: 500, code: 'serverError', detail: INCOMPLETE_GUIDES },
    })

    const detail = screen.getByTestId('ui-learn-detail')
    // The sentence naming the missing agent IS the useful thing on screen; the
    // generic sentence must not replace it.
    expect(detail.textContent).toContain(INCOMPLETE_GUIDES)
    expect(detail.textContent).toContain(COPY('state.detail'))
    expect(screen.queryByTestId('ui-learn-reason')).toBeNull()
    expect(screen.queryByTestId('ui-learn-sheet')).toBeNull()
    expect(screen.getByTestId('ui-learn-retry')).toBeTruthy()
  })

  it('falls back to its own sentence only when the server sent none', () => {
    renderSection({
      status: 'error', person: null, agents: [],
      failure: { ok: false, status: 502, code: 'hostUnavailable', detail: null },
    })

    expect(screen.queryByTestId('ui-learn-detail')).toBeNull()
    expect(screen.getByTestId('ui-learn-reason').textContent).toBe(COPY('error.hostUnavailable'))
  })

  it('offers a retry that re-requests', () => {
    const { load } = renderSection({
      status: 'error', person: null, agents: [],
      failure: { ok: false, status: 503, code: 'unavailable', detail: RESTARTING },
    })

    fireEvent.click(screen.getByTestId('ui-learn-retry'))

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shows a roster with no agents as its own answer, with no retry', () => {
    renderSection({ status: 'ready', person: { id: 'hannah', name: 'Hannah' }, agents: [] })

    expect(within(screen.getByTestId('ui-learn-empty')).getByText(COPY('state.empty.title'))).toBeTruthy()
    expect(screen.queryByTestId('ui-learn-sheet')).toBeNull()
    expect(screen.queryByTestId('ui-learn-retry')).toBeNull()
    expect(screen.queryByText(COPY('state.refused.title'))).toBeNull()
  })

  it('shows a refused profile with the refusal sentence, and no retry', () => {
    const { load } = renderSection({
      status: 'refused', person: null, agents: [],
      failure: { ok: false, status: 403, code: 'forbidden', detail: GUEST_REFUSAL },
    })

    expect(within(screen.getByTestId('ui-learn-refused')).getByText(COPY('state.refused.title'))).toBeTruthy()
    expect(screen.getByTestId('ui-learn-refused-detail').textContent).toContain(GUEST_REFUSAL)
    // A refusal is a policy answer; retrying cannot change it, and it must not
    // be confused with the empty roster above.
    expect(screen.queryByTestId('ui-learn-retry')).toBeNull()
    expect(screen.queryByTestId('ui-learn-empty')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('through the real wire client', () => {
  it('renders the guides e-server answers', async () => {
    const { requests } = await renderLive([answer(200, LEARN_PAYLOAD)])

    await screen.findByTestId('ui-learn-sheet')
    expect(requests).toHaveLength(1)
    expect(screen.getByTestId('ui-learn-person').textContent).toBe('Guides for Owen')
    expect(screen.getByText('Memory and privacy')).toBeTruthy()
  })

  it('shows the 500 sentence when the deployment’s guides are incomplete', async () => {
    await renderLive([answer(500, { detail: INCOMPLETE_GUIDES })])

    const detail = await screen.findByTestId('ui-learn-detail')
    expect(detail.textContent).toContain(INCOMPLETE_GUIDES)
    expect(screen.queryByTestId('ui-learn-sheet')).toBeNull()
  })

  it('shows the Guest refusal and offers no retry', async () => {
    await renderLive([answer(403, { detail: GUEST_REFUSAL })])

    await screen.findByTestId('ui-learn-refused')
    expect(screen.getByTestId('ui-learn-refused-detail').textContent).toContain(GUEST_REFUSAL)
    expect(screen.queryByTestId('ui-learn-retry')).toBeNull()
  })

  it('re-requests on retry and shows the next failure again, never a success claim', async () => {
    const { requests } = await renderLive([
      answer(500, { detail: INCOMPLETE_GUIDES }),
      answer(503, { detail: RESTARTING }),
    ])
    expect((await screen.findByTestId('ui-learn-detail')).textContent).toContain(INCOMPLETE_GUIDES)

    fireEvent.click(screen.getByTestId('ui-learn-retry'))

    await waitFor(() => { expect(screen.getByTestId('ui-learn-detail').textContent).toContain(RESTARTING) })
    expect(requests).toHaveLength(2)
    expect(screen.queryByTestId('ui-learn-sheet')).toBeNull()
    expect(screen.getByTestId('ui-learn-retry')).toBeTruthy()
  })

  /*
   * MUTATION-CHECK. Drop one section's `body` from the real payload: the guide
   * is now incomplete, and the tab must say so rather than quietly render the
   * other four as if the guide were whole. Loosen `parseSection` (accept a
   * section without a body) and this test fails — the sheet renders instead of
   * the failure state.
   */
  it('renders the failure path when a payload arrives with a section missing', async () => {
    const broken = structuredClone(LEARN_PAYLOAD) as unknown as {
      agents: { sections: Record<string, unknown>[] }[]
    }
    delete broken.agents[0]!.sections[2]!['body']

    await renderLive([answer(200, broken)])

    await screen.findByTestId('ui-learn-error')
    expect(screen.getByTestId('ui-learn-reason').textContent).toBe(COPY('error.malformed'))
    expect(screen.queryByTestId('ui-learn-sheet')).toBeNull()
    // The four sections that did arrive are not shown beside the failure: a
    // half guide would read as a short guide.
    expect(screen.queryByText('What Delta is for')).toBeNull()
  })
})

describe('paragraphs', () => {
  it('splits on a blank line and drops the empties', () => {
    expect(paragraphs('one\n\ntwo\n\n\nthree')).toStrictEqual(['one', 'two', 'three'])
    expect(paragraphs('  \n\n  ')).toStrictEqual([])
  })
})
