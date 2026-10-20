/**
 * Wire client for the browser inbox API: three same-origin endpoints served by
 * the e-server origin that serves this page. They sit at the ROOT of that
 * origin (`/v1/browser/inbox`), never under the page's own `/_dsh/` prefix.
 *
 * The caller's browser profile cookie is the whole authentication, so no
 * request here carries a person: the server intersects the signed-in person's
 * roster with what the deployment can compose and returns the rows already
 * filtered and ordered. Nothing in this module knows an agent id, a display
 * name, or a colour.
 *
 * Every call folds both refusal shapes — a rejected transport and a non-2xx
 * status — into one result value, so callers branch on a code and never on an
 * exception. Nothing here throws.
 */

/** List endpoint: the caller's inbox (person plus their rows). */
export const INBOX_LIST_PATH = '/v1/browser/inbox'
/** Open endpoint: resolve-or-create one (person, agent) conversation. */
export const INBOX_OPEN_PATH = '/v1/browser/inbox/open'
/** Clear endpoint: destroy one (person, agent) conversation. */
export const INBOX_CLEAR_PATH = '/v1/browser/inbox/clear'

/** Default request budget; a hung host surfaces as a retryable failure. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Why a call failed, in terms the panel has copy for.
 *
 * `conflict` is the open endpoint's 409: a conversation exists under the
 * deterministic id but was composed with a different agent
 * (`agent-preset-conflict`). It is a real error, never a success.
 *
 * `hostUnavailable` is the open endpoint's 502: the host answered but could not
 * seed the conversation (for example no workspace). The conversation therefore
 * does NOT exist, and the row must report the open failure rather than open a
 * pane the person cannot type in.
 */
export type InboxFailureCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  | 'hostUnavailable'
  | 'notFound'
  | 'timeout'
  | 'transport'
  | 'malformed'
  | 'unexpected'

/** One agent row exactly as the server returned it. */
export interface InboxAgentRow {
  /** Agent id the deployment composes (a preset id). */
  agent: string
  /** Display name the server chose for that agent. */
  name: string
  /** Whether this person already has a conversation with the agent. */
  hasConversation: boolean
  /** That conversation's session id, null when there is none. */
  sessionId: string | null
  /** The conversation exists but holds no messages. */
  blank: boolean
  /** Epoch seconds of the last message, null when there is no conversation. */
  lastActivityAt: number | null
  /** The agent is working right now. */
  running: boolean
  /** Whether the configured agent can run on this deployment. */
  enabled?: boolean
  /** Explicit policy disablement, rather than temporary unavailability. */
  disabled?: boolean
  /** Online, offline, active, unread completion, or terminal failure. */
  presence?: 'online' | 'offline' | 'running' | 'unread' | 'error'
  /** Durable completed-turn event sequence used by read receipts. */
  completion?: number
}

/** The signed-in person the server resolved from the profile cookie. */
export interface InboxPerson {
  /** Profile id (never rendered). */
  id: string
  /** Display name. */
  name: string
}

/** `GET /v1/browser/inbox` body. */
export interface InboxListPayload {
  person: InboxPerson
  agents: readonly InboxAgentRow[]
}

/** `POST /v1/browser/inbox/open` body. */
export interface InboxOpenPayload {
  agent: string
  sessionId: string
  /** True only when this call made the conversation. */
  created: boolean
  blank: boolean
  lastActivityAt: number | null
}

/** `POST /v1/browser/inbox/clear` body. */
export interface InboxClearPayload {
  agent: string
  hasConversation: boolean
  sessionId: string | null
  blank: boolean
  lastActivityAt: number | null
  /** False means the conversation still exists: never render that as cleared. */
  cleared: boolean
}

/** A transport failure: `status` is 0 when no response arrived. */
export interface InboxFailure {
  ok: false
  status: number
  code: InboxFailureCode
}

/** Either the parsed body or a failure. */
export type InboxOutcome<T> = { ok: true; value: T } | InboxFailure

/** The three calls, as the panel and the controller use them. */
export interface InboxApi {
  /** Read the caller's inbox. */
  list: () => Promise<InboxOutcome<InboxListPayload>>
  /** Resolve-or-create one conversation. */
  open: (agent: string) => Promise<InboxOutcome<InboxOpenPayload>>
  /** Destroy one conversation. */
  clear: (agent: string) => Promise<InboxOutcome<InboxClearPayload>>
}

/** Just the slice of `fetch` this module uses (tests supply their own). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Status → failure code. 403 is only reachable on open/clear (the list filters). */
function failureCodeFor(status: number): InboxFailureCode {
  switch (status) {
    case 401: return 'unauthenticated'
    case 403: return 'forbidden'
    case 404: return 'notFound'
    case 409: return 'conflict'
    case 502: return 'hostUnavailable'
    case 503: return 'unavailable'
    default: return 'unexpected'
  }
}

/** Whether a value is a plain object we can read fields off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string field, or undefined when it is absent or the wrong type. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a boolean field, or undefined when it is absent or the wrong type. */
function booleanField(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Read a nullable epoch-seconds field (null and absent both read as null). */
function epochField(source: Record<string, unknown>, key: string): number | undefined | null {
  const value = source[key]
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a nullable string field (null and absent both read as null). */
function nullableStringField(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key]
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse one agent row. A row the server did not spell out is refused rather
 * than guessed at: inventing a row would invent an agent for a person.
 * @param raw - one entry of the list body's `agents` array.
 * @returns the row, or undefined when the shape is not one.
 */
function parseAgentRow(raw: unknown): InboxAgentRow | undefined {
  if (!isRecord(raw)) return undefined
  const agent = stringField(raw, 'agent')
  const name = stringField(raw, 'name')
  const hasConversation = booleanField(raw, 'hasConversation')
  const blank = booleanField(raw, 'blank')
  const running = booleanField(raw, 'running')
  const sessionId = nullableStringField(raw, 'sessionId')
  const lastActivityAt = epochField(raw, 'lastActivityAt')
  if (agent === undefined || name === undefined || hasConversation === undefined
    || blank === undefined || running === undefined
    || sessionId === undefined || lastActivityAt === undefined) return undefined
  const enabled = booleanField(raw, 'enabled')
  const disabled = booleanField(raw, 'disabled')
  const presence = raw['presence']
  const completion = raw['completion']
  if (enabled === undefined || disabled === undefined
    || (presence !== 'online' && presence !== 'offline' && presence !== 'running' && presence !== 'unread' && presence !== 'error')
    || typeof completion !== 'number' || !Number.isSafeInteger(completion) || completion < 0) return undefined
  return { agent, name, hasConversation, sessionId, blank, lastActivityAt, running, enabled, disabled, presence, completion }
}

/** Parse the list body. */
function parseList(raw: unknown): InboxListPayload | undefined {
  if (!isRecord(raw)) return undefined
  const person = raw['person']
  const agents = raw['agents']
  if (!isRecord(person) || !Array.isArray(agents)) return undefined
  const id = stringField(person, 'id')
  const name = stringField(person, 'name')
  if (id === undefined || name === undefined) return undefined
  const rows: InboxAgentRow[] = []
  for (const entry of agents) {
    const row = parseAgentRow(entry)
    if (row === undefined) return undefined
    rows.push(row)
  }
  return { person: { id, name }, agents: rows }
}

/** Parse the open body. */
function parseOpen(raw: unknown): InboxOpenPayload | undefined {
  if (!isRecord(raw)) return undefined
  const agent = stringField(raw, 'agent')
  const sessionId = stringField(raw, 'sessionId')
  const created = booleanField(raw, 'created')
  const blank = booleanField(raw, 'blank')
  const lastActivityAt = epochField(raw, 'lastActivityAt')
  if (agent === undefined || sessionId === undefined || created === undefined
    || blank === undefined || lastActivityAt === undefined) return undefined
  return { agent, sessionId, created, blank, lastActivityAt }
}

/** Parse the clear body. */
function parseClear(raw: unknown): InboxClearPayload | undefined {
  if (!isRecord(raw)) return undefined
  const agent = stringField(raw, 'agent')
  const hasConversation = booleanField(raw, 'hasConversation')
  const blank = booleanField(raw, 'blank')
  const cleared = booleanField(raw, 'cleared')
  const sessionId = nullableStringField(raw, 'sessionId')
  const lastActivityAt = epochField(raw, 'lastActivityAt')
  if (agent === undefined || hasConversation === undefined || blank === undefined
    || cleared === undefined || sessionId === undefined || lastActivityAt === undefined) return undefined
  return { agent, hasConversation, sessionId, blank, lastActivityAt, cleared }
}

/**
 * Build the inbox wire client.
 * @param fetchImpl - fetch implementation (defaults to the page's global).
 * @param timeoutMs - per-request budget; expiry reads as a retryable failure.
 * @returns the three calls.
 */
export function createInboxApi(
  fetchImpl?: FetchLike,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): InboxApi {
  const call = async <T>(
    path: string,
    body: { agent: string } | undefined,
    parse: (raw: unknown) => T | undefined,
  ): Promise<InboxOutcome<T>> => {
    const send = fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init))
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, timeoutMs)
    let response: Response
    try {
      response = await send(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        signal: abort.signal,
        ...body === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      })
    } catch {
      // A rejected transport (offline, DNS, CORS, abort) never reaches the
      // status branch: the panel shows one retryable row either way.
      return { ok: false, status: 0, code: abort.signal.aborted ? 'timeout' : 'transport' }
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) return { ok: false, status: response.status, code: failureCodeFor(response.status) }
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      return { ok: false, status: response.status, code: 'malformed' }
    }
    const value = parse(raw)
    if (value === undefined) return { ok: false, status: response.status, code: 'malformed' }
    return { ok: true, value }
  }

  return {
    list: () => call(INBOX_LIST_PATH, undefined, parseList),
    open: agent => call(INBOX_OPEN_PATH, { agent }, parseOpen),
    clear: agent => call(INBOX_CLEAR_PATH, { agent }, parseClear),
  }
}
