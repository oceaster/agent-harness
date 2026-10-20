# @deepseek-ai/dsh-llm-deepseek

English | [中文](README.zh.md)

DeepSeek chat-completions adapter for the harness LLM seam: direct `fetch` + SSE (framed by `eventsource-parser`) translating the official wire format (source of truth: the API docs — guides/thinking_mode, guides/tool_calls, api/create-chat-completion) into the `StreamChunk` protocol.

A second, library-backed implementation of the same seam exists in `@deepseek-ai/dsh-llm-pi-ai`. This package owns the `deepseek-official` provider route — deliberately distinct from pi-ai's catalog name `deepseek`, so one composition can mount both DeepSeek paths side by side; registering another adapter for `deepseek-official` itself still throws `LlmError('DUPLICATE_ADAPTER')`.

The package root exposes the Cordis plugin contract and `DeepSeekAdapter`; wire serialization, SSE parsing, and chunk translation helpers are not part of that root contract.

## Config

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    baseURL: https://api.deepseek.com # optional; $DEEPSEEK_BASE_URL then the public API when omitted
    thinking: enabled        # optional; provider default is enabled
    reasoningEffort: high    # optional; off | low | high | max — omitted ⇒ high
    maxTokens: 256000        # optional positive per-request output cap; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    maxRequestImageBytes: 20971520 # optional positive integer; 20 MiB base64-payload default
    retryPolicy:             # optional; omission uses normal mode with five retries
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    defaultContextWindow: 1000000 # optional positive-integer fallback; this is the default
    catalogRefreshMs: 900000 # optional; minimum interval between provider catalog refreshes; 0 disables
    models:                  # optional; omission derives the catalog from the provider's own listing
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash
      - id: private-vision
        name: Private Vision
        inputModalities: [text, image]
      - id: private-reasoner
        description: Company-hosted reasoning model
        contextWindow: 512000
```

The plugin registers the single provider route `deepseek-official` together with its resolved `retryPolicy`; omission resolves to normal mode with five retries. A request selects it with `provider: deepseek-official`; its `model` is passed through as the wire `model` string, so changing DeepSeek models does not require lifecycle-time registration. Omitting `models` advertises the built-in catalog — `deepseek-flash` (`DeepSeek-V4.1-Flash`, 1,048,576-token context, 393,216-token output cap, text and image input) and `deepseek-v4-pro` (`DeepSeek-V4-Pro`, the same capacities, text input only) — which the provider's own listing replaces while no list is pinned; see Provider catalog discovery below. An explicit list replaces the built-in one wholesale and stops discovery from running, while `models: []` advertises none. A deployment's own model adds its capabilities with `inputModalities: [text, image]`. Catalog entries are exposed through `ctx.llm.listModels('deepseek-official')` for clients such as ACP editors and the Web selector, but remain advisory: unlisted model ids still pass through unchanged. An omitted entry name defaults to its id, and omitted `inputModalities` means `text` only.

An image-capable catalog entry may declare `inputModalities: [text, image]`. The adapter resolves user and tool-result `ImageBlock` references through `ctx.attachments`, verifies the stored bytes, and sends transient `data:<media-type>;base64,...` `image_url` parts without changing the durable session message. Text-only and unlisted models reject image input before credential, attachment, or network I/O. System and assistant history remain image-free; tool-result images follow their string-only `tool` messages in a separate `user` message.

`maxRequestImageBytes` bounds accumulated base64 image payload and defaults to 20 MiB, leaving headroom below the official 30 MiB request-body limit for text, tools, and JSON framing. When history exceeds the bound, the oldest images become the fixed model-visible placeholder `[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]` until the request fits; omitted attachments are not read. Attachment admission continues to own per-image and per-message raw-byte, media, dimension, and pixel limits.

`contextWindow` is optional per configured model and is not exposed through the advisory catalog. `ctx.llm.resolveModelInfo('deepseek-official', model).context` returns an exact model value first, then `defaultContextWindow` for an entry without capacity or an unlisted pass-through id. The adapter default is 1,000,000; pressure-sensitive plugins therefore get deployment-owned capacity without treating the model selector as authoritative. Registering another adapter for `deepseek-official` throws `LlmError('DUPLICATE_ADAPTER')`.

`maxTokens` is the adapter-configured output cap for conversation requests and defaults to 256,000. A catalog entry may carry its own `maxTokens`, which wins for that model; an entry without one, and any unlisted pass-through id, resolve to the profile value, so adding a per-model cap changes one model rather than the route. Exact-model resolution exposes the winner as `defaultMaxTokens`; `LlmRuntime` materializes that value into `GenerateOptions.maxTokens` before the agent loop writes `request/header`, so the wire request remains reconstructable. An explicit request or `AgentOptions.maxTokens` value wins and is serialized as `max_tokens`. The adapter does not clamp this request budget against `contextWindow`; deployments with a smaller context or provider output limit must configure a compatible `maxTokens`.

The same exact-model result exposes ordered `off`, `low`, `high`, and `max` efforts under `reasoning` for every pass-through model when deployment policy permits thinking. `reasoningEffort` selects the deployment default and falls back to `high` when omitted. `agent/request` can replace it on each conversation step; the resolved value is logged in `request/header`. `low`, `high`, and `max` enable thinking and serialize as the same official top-level `reasoning_effort` value; adapter-owned `off` instead serializes `thinking.type: disabled` and omits `reasoning_effort`. An unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O.

`thinking: disabled` is a deployment lock that publishes only `off` with `off` as its default. Omitting `reasoningEffort` or configuring it as `off` is valid; configuring `low`, `high`, or `max` fails plugin loading, and a direct per-request attempt to enable thinking fails before network I/O. A request with `GenerateOptions.purpose: 'session-title'` also forces thinking disabled and omits the already-resolved effort, reserving its bounded output for visible title text without changing conversation or compaction defaults.

`streamIdleTimeoutMs` bounds each outstanding provider read, including the initial `fetch`, without counting time the consumer spends between chunks. DeepSeek SSE comments rearm an outstanding read as transport activity but never become `StreamChunk` values or session-log events. One stable abort signal reaches the request and body reader for the whole call; expiry stops the transport and throws `LlmError('TIMEOUT')`, while an earlier caller abort throws `LlmError('ABORTED')`. The adapter makes exactly one provider request per `stream()` call; it registers the configured policy as provider metadata, and `dsh-llm-retry` separately executes it at durable agent-step boundaries.

## Provider catalog discovery

The advisory catalog tracks the provider instead of a literal. `listModels` and `resolveModel` serve the catalog this route already holds and start a background refresh behind them, so a turn never waits for the network: the read that starts a refresh still answers from the cached catalog, and the refreshed result applies from the next read. A refresh is one `GET ${baseURL}/models` carrying this route's own bearer credential, bounded by a five-second budget and a 4 MiB reply ceiling. One runs at a time, and at most one is attempted per `catalogRefreshMs`.

The refresh reads `id` plus `name`/`display_name`, `context_window`/`context_length`, `max_output_tokens`/`max_tokens`, and `input_modalities`. A row without a usable id is skipped rather than failing the refresh, a repeated id keeps its first position, and a withheld field keeps the value the built-in catalog already knew for that id: a listing that stops sending `input_modalities` must not silently turn image input off for `deepseek-flash`. An id the built-in catalog never described falls back per field to `defaultContextWindow`, `maxTokens`, and text-only input.

Precedence is explicit. A `models` list pinned in the `llm-deepseek` settings section, or one that differs from the built-in catalog, wins wholesale and stops discovery from running at all; without one the last good provider listing serves; without one of those the built-in catalog serves. A missing credential, an unreachable endpoint, a gateway without the route (404), a refusal (401), a malformed or oversized reply, and a 200 that advertises no models all keep the last good catalog, are reported once rather than per read, and widen the wait before the next attempt — four doublings, so a listing route that stays broken costs a handful of requests a day instead of one per turn.

Discovery moves the advisory catalog only. It decides which ids, display names, capacities, and modalities the route advertises, and it never re-points a configured selection: an id the listing does not advertise is reported once per process, naming the id and what the provider does advertise, and is still served unchanged — a gateway with a partial listing and a provider alias both remain servable.

Configuration surfaces interrogate the same endpoint through `ctx.llm.registerModelDiscovery('llm-deepseek', ...)`. The Models page's fetch action asks the endpoint the draft names, with the one-shot key the form carries or else this route's stored key, honors caller cancellation, and stores nothing: a probe never changes what a turn serves.

## Dynamic configuration (settings + credentials)

Connection facts are not frozen at load. `resolveAdapterOptions` is the one explicit resolve step from raw config to validated facts, and the adapter re-reads them through a thunk **once per operation**: base URL, catalog, request defaults, image bound, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. Three optional seams feed that thunk:

- **`ctx.settings`** — the plugin registers the `llm-deepseek` namespace with this same `Config` schema and its `cordis.yml` entry as the composition `base`, so a `llm-deepseek:` section in the user settings document overrides any field without a restart. Without a mounted settings service the entry config alone drives the adapter, unchanged. A live settings snapshot that passes the schema but fails a beyond-schema bound (a duplicate catalog id, a broken thinking/effort pair) keeps the last good facts and logs the failure; the entry config itself still fails plugin load.
- **`ctx.credentials`** — the API key resolves per stream call, from the *same* resolved snapshot that supplies the endpoint. Configuration carries only `apiKeyEnv`, never a literal key: the reference resolves through the credential seam, and without a mounted seam through the trusted environment layers. Because credential facts travel with the connection facts, a settings snapshot the resolver rejects contributes neither its endpoint nor its key: the whole previous generation keeps serving. Every resolved key is format-checked before use, so a value no HTTP header can carry is refused with `LlmError('INVALID_CREDENTIAL')` naming the failing entry point — never any part of the key — instead of surfacing as an opaque `fetch` `TypeError`. A request with no key anywhere fails with `MISSING_CREDENTIAL` naming every configuration entry point, while the route stays registered and the catalog stays browsable — first-run onboarding is "browse models, store the key, prompt again", with no restart between.
- **`ctx.attachments`** — image requests resolve this service at request time, so Cordis load order does not freeze optional image availability. Absence rejects image input with `UNSUPPORTED_CONTENT`; text-only calls do not require the service.

The one registration-captured fact is the retry policy: when its resolved value changes, the plugin re-registers the route in place (same adapter instance, one synchronous section), so `ctx.llm.providerRetryPolicy('deepseek-official')` always reports the current policy.

The plugin also declares its route in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`): provider `deepseek-official`, settings namespace `llm-deepseek`, empty settings path — the whole section is the profile. Configuration surfaces use that entry to offer this adapter alongside dormant pi-ai providers.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` - the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)). Direct DeepSeek requests and OpenAI-compatible gateway requests get no provider-specific app-attribution headers under this adapter contract; OpenRouter app attribution is deferred to a future explicit OpenRouter adapter or mode. A request whose `GenerateOptions.purpose` is `compaction` (dsh-compaction-basic's auxiliary summarization call) additionally carries `x-deepseek-harness-compact: 1`, so the host can separate compaction traffic from conversation requests.

DeepSeek request identity is separate from app attribution. After credential resolution, every provider request carries `x-deepseek-harness-user-id` with the stable anonymous id from [`@deepseek-ai/dsh-anonymous-user-id`](../../identity/anonymous-user-id/README.md); a request carrying `GenerateOptions.sessionId` also sends that exact value as `x-deepseek-harness-session-id`, while a direct call without a session omits the session header. Both headers go to the resolved `baseURL`, including a configured gateway, and remain outside the request body and model-visible content.

## Wire-format notes

- Streaming only (`stream_options.include_usage` always on). `usage` may arrive attached to the finish chunk or as a trailing usage-only chunk — the translator defers both to `[DONE]`, so `usage` always precedes `finish` and nothing follows `finish`.
- The adapter-owned `off` effort maps to `thinking: {type: 'disabled'}` and never crosses the wire as `reasoning_effort: 'off'`.
- The first thinking-mode chunk carries `reasoning_content: ""` — handled (no spurious reasoning block).
- **Reasoning passback rule**: every assistant turn that carried reasoning serializes `reasoning_content` back in history. Thinking mode requires it on tool-call turns; DeepSeek ignores it elsewhere, while a gateway re-encoding the conversation for another vendor recovers that turn's upstream thinking signature by hashing the replayed text.
- Image-capable user messages preserve text/image order. Tool-role content remains a string; consecutive tool-result images are grouped into the following user message with `Attached image(s) from tool result:`.
- Cache accounting: `cacheReadTokens` ← `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`; DeepSeek reports no cache-write metric.

## Errors

Non-2xx responses throw `LlmError` with stable codes: `AUTH` (401/403), `QUOTA` (a response whose provider details identify exhausted quota, balance, or credits), `RATE_LIMIT` (other 429s), `CONTEXT_WINDOW_EXCEEDED` (a 400 whose provider code, type, or message identifies context overflow), `INVALID_REQUEST` (other 400s and 413), `SERVER` (5xx), `HTTP_<status>` otherwise. Its serializable `failure` retains the HTTP status plus a valid positive `Retry-After` seconds/date delay and `x-request-id` / `x-deepseek-request-id` when present. Attachment reads retain their stable attachment failure code rather than becoming transport failures. A pre-response transport failure (DNS, refused connection, TLS, proxy) throws `TRANSPORT` naming the configured endpoint and chaining the original rejection as `cause`; caller aborts throw `ABORTED`, and the loop's cancellation signal remains authoritative. Protocol violations throw `STREAM_CLOSED` (no `[DONE]`) or `MALFORMED_RESPONSE` (bad JSON payload). Unknown wire `finish_reason`s (e.g. `content_filter`, `insufficient_system_resource`) become `finish {kind: 'error', failure}` chunks, and a completed stream whose `stop` (or absent) finish opened no content blocks becomes a `finish {kind: 'error'}` with code `EMPTY_RESPONSE` (retried by default policy).

## Model Experience

### DeepSeek request

#### What the model sees

The selected DeepSeek model receives the harness system prompt, message history, tool schemas, stop sequences, and call config without adapter-authored prompt prose. The vision model also receives retained user and tool-result images as base64 data URLs; an over-budget older image is represented by the documented placeholder. Reasoning content from a prior assistant turn is passed back verbatim, whether or not that turn called a tool.

#### Token effect

Provider tokenization governs exact text and image-token input. Reasoning passback carries every reasoned turn's chain of thought into later requests, while dropping over-budget images avoids paying those tokens again; cache-read usage is reported when available.

#### KV Cache effect

An unchanged assembled prefix, including deterministically encoded retained images and placeholders, is eligible for DeepSeek cache reuse, which this adapter reports in usage. A model-route change or any upstream prompt, schema, prefix, history, or image-budget change may prevent reuse from the first changed token; reasoning passback appends on every reasoned turn.

### DeepSeek response

#### What the model sees

Reasoning, text, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble.

#### Token effect

Generated tokens follow the request's logged reasoning effort and `maxTokens`; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- **A settings `models` list replaces the composition list wholesale** — settings-layer merging is per-field, and arrays are one field; per-entry catalog merging would need a keyed shape.
- **The provider listing is the only discovery input** — a deployment's endpoint must answer `GET /models` in the OpenAI-compatible shape to contribute anything; an endpoint that answers with an empty `data` array keeps the catalog this route already serves rather than emptying it.
- **A discovered entry inherits the built-in value of a field the listing withholds** — capacities and modalities follow the fallback described above, so a provider that never discloses a field cannot correct the built-in value for an id the built-in catalog already describes.
- **`tool_choice` is not mapped** — not part of the core vocabulary (MVP cut, shared with the pi-ai twin).
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it (`TODO(http)`).
- **Plugin-added content block types are skipped** — core text and supported image blocks are serialized, and empty tool output crosses the wire as the literal `(no output)`.
- **Images are input-only durable attachments** — direct external URLs, the Files API, and assistant image output are not supported.
