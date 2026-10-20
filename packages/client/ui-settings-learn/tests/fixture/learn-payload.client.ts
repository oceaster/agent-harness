/**
 * The real `GET /v1/browser/learn` answer for the Owen profile, loaded from the
 * captured response body beside this module — not a hand-simplified version of
 * it.
 *
 * Why the real words and not placeholders: the section renders prose the browser
 * bundle does not own — three agents, five sections each, paragraphs separated
 * by a blank line, and one section id per agent that only that agent carries
 * (`waiting-and-workers`, `waiting-and-handoff`, `memory-and-privacy`). A fixture
 * of one agent with one section would stay green while the shipped tab dropped
 * sections.
 *
 * The body is stored as JSON and parsed here rather than written as a TypeScript
 * literal, so the bytes are the response the route produced (captured from
 * e-server `api/learn_routes.py` at commit `e6e1f77`, serving
 * `context/agent-guides.json` filtered by `harness_agents.resolve("owen", …)`).
 * The `LearnGuides` annotation is a reading aid; the wire client's own parser is
 * what actually validates the shape, so a drifted fixture fails the parsing
 * suite at runtime.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LearnGuides } from '../../src/client/learn-api.ts'

/* Resolved through `fileURLToPath`, not `new URL(…)`: under the jsdom
 * environment the global `URL` is jsdom's, and Node's `readFileSync` rejects a
 * URL object that is not its own. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The captured response body, verbatim. */
export const LEARN_PAYLOAD: LearnGuides = JSON.parse(
  readFileSync(join(HERE, 'learn-payload.json'), 'utf8'),
) as LearnGuides
