/**
 * Wire client for the browser learn API: ONE same-origin endpoint served by the
 * e-server origin that serves this page, at the ROOT of that origin
 * (`/v1/browser/learn`), never under the page's own `/_dsh/` prefix.
 *
 * The caller's browser profile cookie is the whole authentication, so no
 * request here carries a person: the server resolves the signed-in profile,
 * intersects its roster with what the deployment can compose, and returns the
 * guides already filtered and ordered. Nothing in this module knows an agent
 * id, a display name, a section id, or a word of guide prose.
 *
 * Two refusal shapes fold into one result value, so callers branch on a code
 * and never on an exception:
 *
 * - a rejected transport (`status: 0`), and
 * - a non-2xx status, whose body is FastAPI's `{"detail": ...}`. That sentence
 *   is the USEFUL thing on screen — e-server names the agent whose guide is
 *   missing, or says the harness is restarting — so it is carried through
 *   verbatim rather than replaced by generic copy.
 *
 * Nothing here throws.
 */

/** The one endpoint: the caller's own guides. */
export const LEARN_PATH = '/v1/browser/learn'

/** Default request budget; a hung server surfaces as a retryable failure. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Why a read failed, in terms the section has copy for.
 *
 * `forbidden` is the profile this deployment refuses (Guest answers 403 before
 * any learn route exists). It is a refusal, not a failed read: retrying cannot
 * change it, and the section states it instead of offering a retry.
 */
export type LearnFailureCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'hostUnavailable'
  | 'serverError'
  | 'unavailable'
  | 'notFound'
  | 'timeout'
  | 'transport'
  | 'malformed'
  | 'unexpected'

/** One labelled block of a guide. `body` is plain text, paragraphs split by a blank line. */
export interface LearnSection {
  /** Stable section key, used only as a render key — never switched on. */
  id: string
  /** The section's heading, as the server words it. */
  title: string
  /** The section's prose, verbatim. */
  body: string
}

/** One agent's guide exactly as the server returned it. */
export interface LearnAgent {
  /** Agent id the deployment composes (a preset id); never rendered. */
  agent: string
  /** Display name the server chose for that agent. */
  name: string
  /** Whether the configured agent can run on this deployment. */
  enabled: boolean
  /** One dense paragraph saying what this agent is for. */
  summary: string
  /** The guide's sections, in the server's order. */
  sections: readonly LearnSection[]
}

/** The signed-in person the server resolved from the profile cookie. */
export interface LearnPerson {
  /** Profile id (never rendered). */
  id: string
  /** Display name. */
  name: string
}

/** `GET /v1/browser/learn` 200 body. */
export interface LearnGuides {
  person: LearnPerson
  agents: readonly LearnAgent[]
}

/**
 * A failed read: the status when one arrived, the code the section has copy
 * for, and the server's own sentence when the body carried one.
 */
export interface LearnFailure {
  ok: false
  /** HTTP status, or 0 when no response arrived. */
  status: number
  code: LearnFailureCode
  /**
   * `body.detail` as the server wrote it, or null when the body carried none.
   * FastAPI wraps `HTTPException` payloads this way, including the structured
   * `{error, code, message}` body of a harness refusal.
   */
  detail: string | null
}

/** Either the guides or a failure. */
export type LearnOutcome = { ok: true; value: LearnGuides } | LearnFailure

/** The read, as the section and its controller use it. */
export interface LearnApi {
  /** Read the caller's own guides. */
  read: () => Promise<LearnOutcome>
}

/** Just the slice of `fetch` this module uses (tests supply their own). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Status → failure code. */
function failureCodeFor(status: number): LearnFailureCode {
  switch (status) {
    case 401: return 'unauthenticated'
    case 403: return 'forbidden'
    case 404: return 'notFound'
    case 409: return 'conflict'
    case 500: return 'serverError'
    case 502: return 'hostUnavailable'
    case 503: return 'unavailable'
    default: return 'unexpected'
  }
}

/** Whether a value is a plain object we can read fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string field, or undefined when it is absent, empty, or the wrong type. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read a boolean field, or undefined when it is absent or the wrong type. */
function booleanField(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The readable sentence of a failure body.
 *
 * FastAPI puts it at `body.detail`, which is a string for `HTTPException(500,
 * "…")` and an object for `HTTPException(502, {error, code, message})` — the
 * harness-refusal case. An object's `message` is the sentence a person can act
 * on; a body with no readable string yields null and the section falls back to
 * its own copy.
 * @param raw - the parsed (or failed-to-parse) response body.
 * @returns the server's own sentence, or null.
 */
export function failureDetail(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  const detail = raw['detail']
  if (typeof detail === 'string') return detail.trim() === '' ? null : detail
  if (!isRecord(detail)) return null
  return stringField(detail, 'message') ?? stringField(detail, 'detail') ?? stringField(detail, 'error') ?? null
}

/**
 * Parse one section. A section the server did not spell out is refused rather
 * than guessed at: a guide missing a block would otherwise read as a complete
 * guide that simply stopped early.
 * @param raw - one entry of an agent's `sections` array.
 * @returns the section, or undefined when the shape is not one.
 */
function parseSection(raw: unknown): LearnSection | undefined {
  if (!isRecord(raw)) return undefined
  const id = stringField(raw, 'id')
  const title = stringField(raw, 'title')
  const body = stringField(raw, 'body')
  if (id === undefined || title === undefined || body === undefined) return undefined
  return { id, title, body }
}

/**
 * Parse one agent's guide.
 * @param raw - one entry of the payload's `agents` array.
 * @returns the guide, or undefined when the shape is not one.
 */
function parseAgent(raw: unknown): LearnAgent | undefined {
  if (!isRecord(raw)) return undefined
  const agent = stringField(raw, 'agent')
  const name = stringField(raw, 'name')
  const enabled = booleanField(raw, 'enabled')
  const summary = stringField(raw, 'summary')
  const sections = raw['sections']
  if (agent === undefined || name === undefined || enabled === undefined
    || summary === undefined || !Array.isArray(sections)) return undefined
  const rows: LearnSection[] = []
  for (const entry of sections) {
    const section = parseSection(entry)
    if (section === undefined) return undefined
    rows.push(section)
  }
  return { agent, name, enabled, summary, sections: rows }
}

/**
 * Parse the payload. Every key is required, so a response that drifted a field
 * is reported instead of half-rendered.
 * @param raw - the parsed response body.
 * @returns the guides, or undefined when the shape is not one.
 */
function parseGuides(raw: unknown): LearnGuides | undefined {
  if (!isRecord(raw)) return undefined
  const person = raw['person']
  const agents = raw['agents']
  if (!isRecord(person) || !Array.isArray(agents)) return undefined
  const id = stringField(person, 'id')
  const name = stringField(person, 'name')
  if (id === undefined || name === undefined) return undefined
  const rows: LearnAgent[] = []
  for (const entry of agents) {
    const agent = parseAgent(entry)
    if (agent === undefined) return undefined
    rows.push(agent)
  }
  return { person: { id, name }, agents: rows }
}

/**
 * Read a failure body without letting a parse failure become the failure: an
 * empty, HTML, or truncated body simply carries no detail.
 * @param response - the non-2xx response.
 * @returns the body's readable sentence, or null.
 */
async function readFailureDetail(response: Response): Promise<string | null> {
  try {
    return failureDetail(await response.json())
  } catch {
    /* A body that is not JSON (a proxy error page, an empty 401) still has a
     * status; the section's own copy covers the case it cannot name. */
    return null
  }
}

/**
 * Build the learn wire client.
 * @param fetchImpl - fetch implementation (defaults to the page's global).
 * @param timeoutMs - per-request budget; expiry reads as a retryable failure.
 * @returns the read.
 */
export function createLearnApi(
  fetchImpl?: FetchLike,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): LearnApi {
  return {
    read: async (): Promise<LearnOutcome> => {
      const send = fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))
      const abort = new AbortController()
      const timer = setTimeout(() => { abort.abort() }, timeoutMs)
      let response: Response
      try {
        response = await send(LEARN_PATH, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: abort.signal,
        })
      } catch {
        // A rejected transport (offline, DNS, CORS, abort) never reaches the
        // status branch: the section shows one retryable state either way.
        return { ok: false, status: 0, code: abort.signal.aborted ? 'timeout' : 'transport', detail: null }
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        return { ok: false, status: response.status, code: failureCodeFor(response.status),
          detail: await readFailureDetail(response) }
      }
      let raw: unknown
      try {
        raw = await response.json()
      } catch {
        return { ok: false, status: response.status, code: 'malformed', detail: null }
      }
      const value = parseGuides(raw)
      if (value === undefined) return { ok: false, status: response.status, code: 'malformed', detail: null }
      return { ok: true, value }
    },
  }
}
