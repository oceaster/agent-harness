/**
 * The DeepSeek route's advisory catalog: the built-in list, the provider's own
 * `GET /models` listing, and the cache that decides which one a catalog read
 * sees.
 *
 * Discovery is advisory. It changes which ids, display names, capacities, and
 * input modalities this route advertises; it never re-points a configured model
 * selection, and a missing credential, an unreachable endpoint, a refusal, a
 * malformed reply, an oversized reply, or a listing that advertises nothing
 * leaves the catalog exactly as it was. Every failure is reported once, never
 * per read, and no read ever waits for the network.
 *
 * @module dsh-llm-deepseek/catalog
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest, ModelModality } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { DeepSeekCatalogModel } from './adapter.ts'

/** Input modalities a DeepSeek model may accept, in presentation order. */
export const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/**
 * The catalog served when no operator list is configured and no provider
 * listing has been read: exactly what `api.deepseek.com` advertises today.
 * `deepseek-flash` is the provider-maintained pointer to the current Flash
 * model — its versioned and dated spellings are refused — and Flash accepts
 * image input while V4 Pro does not.
 */
export const STATIC_CATALOG: readonly DeepSeekCatalogModel[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1_048_576,
    maxTokens: 393_216,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1_048_576,
    maxTokens: 393_216,
  },
]

/** Default interval between two provider listing refreshes (15 minutes). */
export const DEFAULT_CATALOG_REFRESH_MS = 900_000

/**
 * Endpoint replies larger than this are refused. The endpoint is a deployment
 * value, so the ceiling holds on the bytes actually read rather than on the
 * length the server claims — the same two-stage shape dsh-web-fetch uses for
 * its own caller-supplied URLs. A truncated model listing is not parseable, so
 * overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * Total time budget for one interrogation, including the body read. A listing
 * that outlives it is abandoned: the refresh is already off the request path,
 * and an endpoint that never answers must not pin a socket for the process
 * lifetime.
 */
const DISCOVERY_TIMEOUT_MS = 5_000

/**
 * Doubling steps a failing refresh may take beyond the configured interval. A
 * 15-minute default therefore settles at one attempt every four hours, so an
 * endpoint whose listing route is missing for good costs a handful of requests a
 * day instead of one per turn.
 */
const MAX_FAILURE_BACKOFF_STEPS = 4

/** Endpoint and credential of one settings generation. */
export interface CatalogConnection {
  /** Endpoint base; `/models` is appended. */
  baseURL: string
  /** Credential reference resolved through the credential seam for this snapshot. */
  apiKeyEnv: CredentialRef
}

/**
 * One model a listing advertised, reduced to the facts this package reads.
 * Every field but the id is optional because a listing may disclose nothing
 * else, and a withheld field must keep the value the catalog already had.
 */
export interface DiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name, when the listing supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
  /** Accepted request modalities, when disclosed. */
  inputModalities?: ModelModality[]
}

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listing. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  input_modalities?: unknown
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** The recognized input modalities one listing disclosed, or `undefined` when it disclosed none. */
function modalities(...candidates: readonly unknown[]): ModelModality[] | undefined {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const accepted: ModelModality[] = []
    for (const entry of candidate) {
      if (typeof entry !== 'string') continue
      const modality = MODEL_MODALITIES.find(known => known === entry)
      if (modality !== undefined && !accepted.includes(modality)) accepted.push(modality)
    }
    if (accepted.length > 0) return accepted
  }
  return undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a prefix
 * rather than a URL to resolve against, so a deployment path such as
 * `http://gateway.internal/openai/v1` keeps its segments.
 * @param baseURL - configured endpoint base.
 * @returns the absolute listing URL.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares or streams tells us nothing up front.
 * @param response - an ok response whose body has not been read.
 * @param url - listing URL, named in the refusal.
 * @returns the complete body text.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on an ok Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a drained or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from an
      // oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one listing reply. Entries without a usable id are skipped rather than
 * failing the whole refresh: a single malformed row must not deny the route the
 * rest of a working endpoint's catalog. Rows keep endpoint order, and an id the
 * endpoint repeats is read once, at its first position.
 * @param body - parsed reply body.
 * @param url - listing URL, named in the refusal.
 * @returns the advertised models, in endpoint order.
 */
function readListing(body: unknown, url: string): DiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(`${url} did not answer with a model list`, 'DISCOVERY_FAILED')
  }
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    const inputModalities = modalities(entry?.input_modalities)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...inputModalities === undefined ? {} : { inputModalities },
    })
  }
  return models
}

/** One interrogation of a provider endpoint. */
export interface ListingRequest {
  /** Endpoint base to interrogate; `/models` is appended. */
  baseURL: string
  /** Bearer token for this call alone; absence asks the endpoint unauthenticated. */
  apiKey?: string
  /** Caller cancellation; the interrogation settles promptly after it aborts. */
  signal?: AbortSignal
}

/**
 * Interrogate one endpoint's `GET /models` listing.
 * @param request - endpoint, optional one-shot credential, and cancellation.
 * @returns the advertised models, in endpoint order.
 * @throws LlmError `DISCOVERY_FAILED` when the endpoint cannot be reached,
 * refuses, or answers something that is not a model listing.
 */
export async function fetchListing(request: ListingRequest): Promise<DiscoveredModel[]> {
  const url = listingUrl(request.baseURL)
  // One budget for the request and the body: an endpoint that trickles bytes
  // must not outlive the same bound that covers a hung connect.
  const budget = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const signal = request.signal === undefined ? budget : AbortSignal.any([request.signal, budget])
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...request.apiKey === undefined ? {} : { authorization: `Bearer ${request.apiKey}` },
        ...attributionHeaders(),
      },
      signal,
    })
  } catch (error: unknown) {
    if (request.signal?.aborted === true) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(
      `${url} answered ${response.status}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // A cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted === true) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body, url)
}

/** One entry of the catalog, detached from the cache. */
function detach(model: DeepSeekCatalogModel): DeepSeekCatalogModel {
  return {
    ...model,
    ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
  }
}

/**
 * One listing row as a catalog entry, keeping the value the built-in catalog
 * already knew for a field the listing withheld. A withheld `inputModalities`
 * must never default to text-only: that would silently turn image input off for
 * a model the catalog already knew accepts it.
 * @param row - one advertised model.
 * @param known - built-in entries by id.
 * @returns the catalog entry this row contributes.
 */
function catalogEntry(row: DiscoveredModel, known: ReadonlyMap<string, DeepSeekCatalogModel>): DeepSeekCatalogModel {
  const baseline = known.get(row.id)
  const name = row.name ?? baseline?.name
  const contextWindow = row.contextWindow ?? baseline?.contextWindow
  const maxTokens = row.maxTokens ?? baseline?.maxTokens
  const inputModalities = row.inputModalities ?? baseline?.inputModalities
  return {
    id: row.id,
    ...name === undefined ? {} : { name },
    ...baseline?.description === undefined ? {} : { description: baseline.description },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...inputModalities === undefined ? {} : { inputModalities: [...inputModalities] },
  }
}

/** What one {@link ProviderCatalog} needs from its plugin. */
export interface ProviderCatalogOptions {
  /** Connection facts of the current settings generation. */
  connection: () => CatalogConnection
  /**
   * The bearer token for one connection snapshot, or `undefined` when this route
   * holds none. `undefined` is not a failure to report loudly: browsing models
   * before storing a key is the documented first-run state.
   */
  resolveApiKey: (connection: CatalogConnection) => Promise<string | undefined>
  /**
   * The operator-pinned catalog, or `undefined` when this route derives its own.
   * A pinned list wins wholesale and stops discovery from running at all.
   */
  pinned: () => readonly DeepSeekCatalogModel[] | undefined
  /** Refresh interval in milliseconds; `0` disables discovery entirely. */
  refreshIntervalMs: () => number
  /** Record one advisory diagnostic. */
  warn: (message: string) => void
}

/**
 * The catalog a route serves, refreshed in the background from the provider's
 * own listing.
 *
 * A read is always answered from memory: the catalog in hand is returned
 * unchanged and a due refresh starts behind it, so a turn never waits for the
 * network and a refresh result applies from the next read. One refresh runs at
 * a time, it is attempted at most once per interval, and its result is
 * discarded when the connection it was started for has been replaced.
 */
export class ProviderCatalog {
  /** Listing rows of the last successful refresh; absent serves the built-in catalog. */
  private rows: readonly DiscoveredModel[] | undefined
  /** {@link rows} as catalog entries, rebuilt only when a refresh applies. */
  private entries: readonly DeepSeekCatalogModel[] | undefined
  /** Identity of the connection {@link rows} were read from. */
  private identity: string | undefined
  /** Start of the last refresh attempt, in epoch milliseconds; `0` means none yet. */
  private attemptedAt = 0
  /** Consecutive settled attempts that produced no new catalog, which widens the wait. */
  private failures = 0
  /** Whether a refresh is running; one per process, so a read cannot start a second. */
  private running = false
  /** Ids already reported as no longer advertised. */
  private readonly reported = new Set<string>()

  constructor(private readonly options: ProviderCatalogOptions) {}

  /**
   * The catalog to serve now: the operator's list, else the last good provider
   * listing, else the built-in catalog.
   * @returns detached catalog entries.
   */
  current(): DeepSeekCatalogModel[] {
    const pinned = this.options.pinned()
    if (pinned !== undefined) return pinned.map(detach)
    this.settle(this.options.connection())
    return (this.entries ?? STATIC_CATALOG).map(detach)
  }

  /**
   * Start a background refresh when one is due. Never awaits, never throws, and
   * does nothing while an operator list is pinned or discovery is disabled.
   */
  refresh(): void {
    try {
      this.attempt()
    } catch (error: unknown) {
      // Nothing else guards the synchronous half of this hook, and it runs
      // inside a catalog read: a refresh that cannot even start must not turn
      // that read into a failed turn.
      this.options.warn(`llm-deepseek: the catalog refresh could not start (${String(error)})`)
    }
  }

  /**
   * Drop the discovered catalog and the refresh schedule, so the next read
   * serves the built-in catalog and the following one may interrogate the
   * endpoint again. Called when the settings section changes.
   */
  invalidate(): void {
    this.rows = undefined
    this.entries = undefined
    this.identity = undefined
    this.attemptedAt = 0
    this.failures = 0
    this.reported.clear()
  }

  /**
   * Report one resolved model id the provider listing does not advertise. The
   * selection itself is left exactly as configured: an id may still be
   * servable through a gateway with a partial listing or through an alias the
   * provider accepts, so this is observation, never correction.
   * @param model - the model id one resolution asked about.
   */
  noteSelection(model: string): void {
    if (this.rows === undefined) return
    if (this.rows.some(row => row.id === model)) return
    this.report(model, `the provider's listing does not advertise "${model}"`)
  }

  /** Whether a refresh is due, backing off while the endpoint keeps failing. */
  private attempt(): void {
    if (this.options.pinned() !== undefined) return
    const connection = this.options.connection()
    this.settle(connection)
    const interval = this.options.refreshIntervalMs()
    if (interval <= 0 || this.running) return
    const now = Date.now()
    // Every settled attempt — success, empty listing, refusal, transport error,
    // timeout, missing credential — starts the wait, because a catalog read runs
    // on every turn and an endpoint that cannot answer must not cost one doomed
    // request per turn. Repeated failures widen the wait, so a listing route that
    // is missing for good costs a handful of attempts an hour at most.
    const wait = interval * 2 ** Math.min(this.failures, MAX_FAILURE_BACKOFF_STEPS)
    if (this.attemptedAt !== 0 && now - this.attemptedAt < wait) return
    // Recorded before the request goes out: concurrent reads share this attempt
    // instead of queueing an attempt each.
    this.attemptedAt = now
    this.running = true
    // Detached from the read on purpose, and settled to total: `run` reports its
    // own failure, and the extra guard keeps a throwing reporter from surfacing
    // as an unhandled rejection that could take the host process down.
    void this.run(connection).catch(() => undefined)
  }

  /** The single background attempt; its failure is reported once and changes nothing. */
  private async run(connection: CatalogConnection): Promise<void> {
    try {
      const apiKey = await this.options.resolveApiKey(connection)
      if (apiKey === undefined) {
        // Storing the key is the fix, and that must reach the next read rather
        // than a backed-off retry, so this costs the base interval only.
        this.options.warn(
          `llm-deepseek: no credential for ${connection.apiKeyEnv} yet, so the catalog for`
          + ` ${connection.baseURL} is not refreshed from the provider`,
        )
        return
      }
      const rows = await fetchListing({ baseURL: connection.baseURL, apiKey })
      if (rows.length === 0) {
        // A gateway that lists nothing is not an empty catalog: it is no
        // information, and replacing the served catalog with it would empty the
        // model selector for every route behind that endpoint.
        this.failures += 1
        this.options.warn(
          `llm-deepseek: ${listingUrl(connection.baseURL)} advertised no models; keeping the catalog`
          + ' this route already serves',
        )
        return
      }
      if (this.identity !== identityOf(connection)) return
      this.apply(rows)
    } catch (error: unknown) {
      this.failures += 1
      this.options.warn(
        `llm-deepseek: model discovery against ${connection.baseURL} failed, keeping the catalog this`
        + ` route already serves (${error instanceof LlmError ? error.message : String(error)})`,
      )
    } finally {
      this.running = false
    }
  }

  /** Serve a fresh listing from the next read, reporting ids it dropped. */
  private apply(rows: readonly DiscoveredModel[]): void {
    this.failures = 0
    const dropped = (this.entries ?? STATIC_CATALOG).filter(model => !rows.some(row => row.id === model.id))
    const known = new Map(STATIC_CATALOG.map(model => [model.id, model]))
    this.rows = rows
    this.entries = rows.map(row => catalogEntry(row, known))
    const advertised = this.entries.map(model => model.id)
    for (const model of dropped) {
      this.report(model.id, `the provider's listing no longer advertises "${model.id}" (it now advertises`
        + ` ${advertised.join(', ')})`)
    }
  }

  /** Reset the cache when the connection it was read from has been replaced. */
  private settle(connection: CatalogConnection): void {
    const identity = identityOf(connection)
    if (this.identity === identity) return
    this.rows = undefined
    this.entries = undefined
    this.attemptedAt = 0
    this.identity = identity
  }

  /** Report one advisory fact about an id, at most once per process. */
  private report(model: string, message: string): void {
    if (this.reported.has(model)) return
    this.reported.add(model)
    this.options.warn(`llm-deepseek: ${message}; served model selections are unchanged`)
  }
}

/** Cache identity of one connection: a different endpoint or credential is a different catalog. */
function identityOf(connection: CatalogConnection): string {
  return `${connection.baseURL}\u0000${connection.apiKeyEnv}`
}

/** What one configuration-surface interrogation needs from its plugin. */
export interface DiscoveryOptions {
  /** Connection facts of the current settings generation. */
  connection: () => CatalogConnection
  /** The bearer token for one connection snapshot, or `undefined` to ask unauthenticated. */
  resolveApiKey: (connection: CatalogConnection) => Promise<string | undefined>
}

/**
 * Answer one configuration surface's "fetch available models" request: ask the
 * endpoint the draft names, with the one-shot credential it carries, and return
 * what it advertises. Nothing is stored — not the credential, and not the
 * result: settings remain the only thing that decides what a route serves, and
 * this route's own refresh cache is untouched so a probe can never re-point a
 * turn.
 * @param request - endpoint, optional one-shot credential, and cancellation.
 * @param options - the route facts a probe without its own endpoint falls back to.
 * @returns the advertised models, in endpoint order.
 * @throws LlmError `DISCOVERY_FAILED` when the endpoint cannot be interrogated.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  options: DiscoveryOptions,
): Promise<readonly LlmDiscoveredModel[]> {
  const connection = options.connection()
  // A key typed into the form wins: it is the one the operator is testing, and
  // it may be the replacement for exactly the stored key that is failing. A
  // probe carrying none falls back to this route's own credential, and asks
  // unauthenticated when the route holds none either.
  const apiKey = request.apiKey ?? await options.resolveApiKey(connection)
  const rows = await fetchListing({
    baseURL: request.baseURL !== undefined && request.baseURL.length > 0 ? request.baseURL : connection.baseURL,
    ...apiKey === undefined ? {} : { apiKey },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  return rows.map(row => ({
    id: row.id,
    ...row.name === undefined ? {} : { name: row.name },
    ...row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow },
    ...row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens },
  }))
}
