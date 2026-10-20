/**
 * The Learn More controller's state machine: one read in flight, one honest
 * answer, and four states that mean four different things.
 *
 * The distinction this suite exists for is between a refusal and an empty
 * roster. e-server answers a Guest 403 `{"detail": "DSH is unavailable to
 * Guest"}` BEFORE the learn route runs, while an authenticated profile whose
 * roster resolves to no agent answers 200 with `"agents": []` — a policy answer
 * about a real person. Rendering either as the other, or as a generic failure,
 * would tell a person the wrong thing about their own account.
 */
import { describe, expect, it } from 'vitest'
import type { LearnFailure, LearnGuides, LearnOutcome } from '../src/client/learn-api.ts'
import { LearnController } from '../src/client/learn-controller.ts'
import { LEARN_PAYLOAD } from './fixture/learn-payload.client.ts'

/** The empty roster answer: a signed-in person this deployment gives no agent. */
const NO_AGENTS: LearnGuides = { person: { id: 'hannah', name: 'Hannah' }, agents: [] }

/** e-server's own sentences, verbatim. */
const GUEST_REFUSAL = 'DSH is unavailable to Guest'
const INCOMPLETE_GUIDES = 'The agent guides are incomplete: no guide in context/agent-guides.json'
  + ' for the dexter agent, which this person may use. Ask Owen to fix them'
const RESTARTING = 'The Agent Harness is restarting; try again in a moment'

/**
 * A wire client whose answers are queued in order; the last one repeats.
 * @param answers - the outcomes to hand back, in call order.
 * @returns the fake api plus the requests it saw.
 */
function queuedApi(answers: readonly LearnOutcome[]) {
  const reads: number[] = []
  return {
    reads,
    api: {
      read: (): Promise<LearnOutcome> => {
        const index = Math.min(reads.length, answers.length - 1)
        reads.push(index)
        return Promise.resolve(answers[index]!)
      },
    },
  }
}

/** A failure value of the shape e-server produces. */
function failure(status: number, code: LearnFailure['code'], detail: string | null): LearnFailure {
  return { ok: false, status, code, detail }
}

describe('learn controller', () => {
  it('starts in loading with nothing to show', () => {
    const controller = new LearnController({ api: queuedApi([{ ok: true, value: LEARN_PAYLOAD }]).api })

    expect(controller.store.getSnapshot()).toStrictEqual({
      status: 'loading', person: null, agents: [], failure: null,
    })
  })

  it('keeps the person and the guides the server returned', async () => {
    const controller = new LearnController({ api: queuedApi([{ ok: true, value: LEARN_PAYLOAD }]).api })

    await controller.load()

    expect(controller.store.getSnapshot()).toStrictEqual({
      status: 'ready', person: LEARN_PAYLOAD.person, agents: LEARN_PAYLOAD.agents, failure: null,
    })
  })

  it('treats an empty roster as a ready answer, not a failure', async () => {
    const controller = new LearnController({ api: queuedApi([{ ok: true, value: NO_AGENTS }]).api })

    await controller.load()

    expect(controller.store.getSnapshot()).toStrictEqual({
      status: 'ready', person: NO_AGENTS.person, agents: [], failure: null,
    })
  })

  it('reports a refused profile as refused, keeping the server sentence', async () => {
    const refusal = failure(403, 'forbidden', GUEST_REFUSAL)
    const controller = new LearnController({ api: queuedApi([refusal]).api })

    await controller.load()

    expect(controller.store.getSnapshot()).toStrictEqual({
      status: 'refused', person: null, agents: [], failure: refusal,
    })
  })

  it('reports a failed read with the sentence that names the missing guide', async () => {
    const incomplete = failure(500, 'serverError', INCOMPLETE_GUIDES)
    const controller = new LearnController({ api: queuedApi([incomplete]).api })

    await controller.load()

    expect(controller.store.getSnapshot()).toStrictEqual({
      status: 'error', person: null, agents: [], failure: incomplete,
    })
  })

  it('drops the guides of an earlier read when the next read fails', async () => {
    const restarting = failure(503, 'unavailable', RESTARTING)
    const controller = new LearnController({
      api: queuedApi([{ ok: true, value: LEARN_PAYLOAD }, restarting]).api,
    })
    await controller.load()

    await controller.load()

    // A stale guide beside a failed read would claim the failure belongs to
    // content that is no longer current.
    expect(controller.store.getSnapshot()).toStrictEqual({
      status: 'error', person: null, agents: [], failure: restarting,
    })
  })

  it('re-reads on a retry and shows the second failure, never a success claim', async () => {
    const { reads, api } = queuedApi([
      failure(500, 'serverError', INCOMPLETE_GUIDES),
      failure(503, 'unavailable', RESTARTING),
    ])
    const controller = new LearnController({ api })
    await controller.load()

    await controller.load()

    expect(reads).toHaveLength(2)
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error', agents: [], failure: { status: 503, detail: RESTARTING },
    })
  })

  it('recovers when a retry succeeds', async () => {
    const { api } = queuedApi([failure(503, 'unavailable', RESTARTING), { ok: true, value: LEARN_PAYLOAD }])
    const controller = new LearnController({ api })
    await controller.load()

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', person: LEARN_PAYLOAD.person, failure: null,
    })
  })

  it('does not stack a second read on top of one in flight', async () => {
    let settle: ((outcome: LearnOutcome) => void) | undefined
    const reads: number[] = []
    const api = {
      read: (): Promise<LearnOutcome> => {
        reads.push(reads.length)
        return new Promise<LearnOutcome>((resolve) => { settle = resolve })
      },
    }
    const controller = new LearnController({ api })

    const first = controller.load()
    const second = controller.load()
    settle?.({ ok: true, value: LEARN_PAYLOAD })
    await Promise.all([first, second])

    expect(reads).toHaveLength(1)
    expect(controller.store.getSnapshot().status).toBe('ready')
  })
})
