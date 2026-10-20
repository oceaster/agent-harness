/**
 * The dictionaries: both languages ship the same key set, and neither one
 * carries a word of guide content.
 *
 * The second half is the load-bearing assertion. The tab's content is served by
 * e-server precisely so that editing the guides never needs a browser rebuild;
 * a locale dictionary holding an agent's name, its summary, or a section title
 * would be a second copy that silently drifts from what the server sends.
 */
import { describe, expect, it } from 'vitest'
import { en, zh, type LearnKey } from '../src/client/locales.ts'
import type { LearnFailureCode } from '../src/client/learn-api.ts'
import { LEARN_PAYLOAD } from './fixture/learn-payload.client.ts'

/** Every failure code the section can name, so a new code cannot ship uncopied. */
const CODES: readonly LearnFailureCode[] = [
  'unauthenticated', 'forbidden', 'conflict', 'hostUnavailable', 'serverError',
  'unavailable', 'notFound', 'timeout', 'transport', 'malformed', 'unexpected',
]

describe('learn locales', () => {
  it('ships the same keys in both languages', () => {
    expect(Object.keys(zh).sort()).toStrictEqual(Object.keys(en).sort())
  })

  it('has copy for every failure code', () => {
    for (const code of CODES) {
      expect(en[`error.${code}` as LearnKey]).toBeTruthy()
      expect(zh[`error.${code}` as LearnKey]).toBeTruthy()
    }
  })

  it('carries no agent name, agent id, summary or section wording of its own', () => {
    const copy = [...Object.values(en), ...Object.values(zh)]
    for (const agent of LEARN_PAYLOAD.agents) {
      expect(copy.some(value => value.includes(agent.name))).toBe(false)
      expect(copy.some(value => value.includes(agent.agent))).toBe(false)
      expect(copy.some(value => value.includes(agent.summary))).toBe(false)
      for (const section of agent.sections) {
        expect(copy.some(value => value.includes(section.title))).toBe(false)
        expect(copy.some(value => value.includes(section.id))).toBe(false)
        expect(copy.some(value => value.includes(section.body))).toBe(false)
      }
    }
  })
})
