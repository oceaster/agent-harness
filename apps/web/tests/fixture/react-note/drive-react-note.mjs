/**
 * Reaction-note measurement driver (ticket f1bdaed3).
 *
 * Drives the keyless fixture in this directory — the REAL built harness with an
 * isolated DSH_HOME and a recording mock provider — and measures, in order:
 *
 *   NEGATIVE  appending through the real `session.react` RPC starts nothing:
 *             one event, no model request, no turn or step, no title, no goal or
 *             retry record, no inbox entry, agent idle.
 *   POSITIVE  the note reaches the model on the NEXT turn, and the request body
 *             the mock recorded says at which index; the turn's own content is
 *             otherwise unchanged.
 *   COMPACTION a `/compact` over a session whose log spans the note puts no
 *             reaction text in the summarization request or in the durable
 *             checkpoint, and the note still reaches the model afterwards.
 *
 * Every "no"/"yes" below is read from the host itself (`/react-note-observe`)
 * or from the request bodies the provider received — never from a claim about
 * which code path runs. Exits non-zero when a measurement contradicts its
 * expected shape.
 *
 * Usage: node drive-react-note.mjs <baseUrl> [outDir]
 *        (MOCK_URL may name the mock; default http://127.0.0.1:3592)
 */
import { mkdir, writeFile } from 'node:fs/promises'

const [baseUrl, outDir = '/tmp/react-note-proof'] = process.argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: node drive-react-note.mjs <baseUrl> [outDir]')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

/** The mock provider's recording endpoint (start-react-note-fixture.sh owns it). */
const mockUrl = process.env.MOCK_URL ?? 'http://127.0.0.1:3592'

const results = {}
const failures = []
function check(name, condition, detail) {
  results[name] = { ok: Boolean(condition), detail }
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail)}`)
}

let rpcCounter = 0
/** One client-request over the real HTTP carrier (`POST /api/<method>`). */
async function rpc(method, payload) {
  const rpcId = `react-note-${++rpcCounter}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`)
  const message = JSON.parse(text)
  if (message.result?.ok !== true) throw new Error(`${method} refused: ${JSON.stringify(message.result)}`)
  return message.result.value
}

/** The same carrier, but returning the refusal instead of throwing. */
async function rpcOutcome(method, payload) {
  const rpcId = `react-note-${++rpcCounter}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const message = JSON.parse(await response.text())
  return message.result
}

/** Host-side observation: event counts, the derived message list, agent state. */
async function observe(sessionId) {
  const response = await fetch(`${baseUrl}/react-note-observe?sessionId=${encodeURIComponent(sessionId)}`)
  const text = await response.text()
  if (!response.ok) throw new Error(`observe HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}

/** Request bodies the mock provider recorded, in arrival order. */
async function readMock() {
  const response = await fetch(`${mockUrl}/__requests`)
  if (!response.ok) throw new Error(`mock /__requests HTTP ${response.status}`)
  return response.json()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Poll until the agent is idle and at least `turnCount` turns have closed. */
async function waitIdle(sessionId, { turnCount, timeoutMs = 60_000 } = {}) {
  const started = Date.now()
  for (;;) {
    const snapshot = await observe(sessionId)
    const turns = snapshot.eventCounts['turn/end'] ?? 0
    if (snapshot.agentStatus === 'idle' && (turnCount === undefined || turns >= turnCount)) return snapshot
    if (Date.now() - started > timeoutMs) {
      throw new Error(`agent did not settle: ${JSON.stringify({ status: snapshot.agentStatus, turns })}`)
    }
    await sleep(100)
  }
}

/** The type-count difference between two observations. */
function countDelta(before, after) {
  const delta = {}
  for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[type] ?? 0) - (before[type] ?? 0)
    if (change !== 0) delta[type] = change
  }
  return delta
}

/** The first append-origin user message's seq — a real reaction target. */
function firstUserMessageSeq(snapshot) {
  const found = snapshot.events.find(event => event.type === 'user/message')
  if (found === undefined) throw new Error('the first turn appended no user/message')
  return found.seq
}

/**
 * The text of one wire message. The provider request carries text-only content
 * as a plain string and block content as an array; both shapes are the real
 * request, so read either.
 */
function wireText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(block => block.type === 'text').map(block => block.text).join('')
  return ''
}

/** Indexes of request messages whose text matches `pattern`. */
function indexesMatching(messages, pattern) {
  return messages
    .map((message, index) => ({ index, role: message.role, text: JSON.stringify(message.content) }))
    .filter(entry => pattern.test(entry.text))
}

const cwd = process.env.DRIVER_CWD ?? '/tmp'

// ── 0. A session with one completed turn ────────────────────────────────────
const created = await rpc('session.create', { cwd, agentPreset: 'code' })
const sessionId = created.sessionId
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn one: name the three tallest trees' }] })
const afterFirst = await waitIdle(sessionId, { turnCount: 1 })
const targetSeq = firstUserMessageSeq(afterFirst)
// An ordinary first prompt costs two model requests in this build: the
// conversation request plus the title provider's own auxiliary call.
const callsAfterFirst = (await readMock()).length
check('first turn produced the conversation request plus the title request',
  callsAfterFirst === 2, { callsAfterFirst })

// ── 1. NEGATIVE: the real RPC appends the note and starts nothing ──────────
const before = await observe(sessionId)
const mockBefore = (await readMock()).length
const titleBefore = (before.eventCounts['session/title'] ?? 0)

const appended = await rpc('session.react', {
  sessionId, targetSeq, emoji: '👍', actor: 'owen',
})
// Give every plausible async wake (driver latch, title provider, projection
// push, goal-round driver) a generous window to move before asserting nothing did.
await sleep(3000)
const after = await observe(sessionId)
const mockAfter = (await readMock()).length
const eventDelta = countDelta(before.eventCounts, after.eventCounts)

check('the RPC appended exactly one reaction/note event',
  appended.seq === after.events.length - 1 && eventDelta['reaction/note'] === 1,
  { returnedSeq: appended.seq, eventDelta })
check('the note carries the envelope ignorable marker',
  after.events.find(event => event.seq === appended.seq)?.ignorable === true,
  after.events.find(event => event.seq === appended.seq))
check('the note payload is exactly the documented four fields',
  JSON.stringify(after.events.find(event => event.seq === appended.seq)?.data)
  === JSON.stringify({ targetSeq, emoji: '👍', actor: 'owen', action: 'added' }),
  after.events.find(event => event.seq === appended.seq)?.data)
check('no model request followed the note', mockAfter === mockBefore, { mockBefore, mockAfter })
check('the agent stayed idle', after.agentStatus === 'idle', after.agentStatus)
check('no inbox entry was created',
  after.inbox.nextTurn === 0 && after.inbox.nextStep === 0, after.inbox)
check('no turn or step boundary opened',
  (eventDelta['turn/start'] ?? 0) === 0 && (eventDelta['step/start'] ?? 0) === 0, eventDelta)
check('no title was generated',
  (after.eventCounts['session/title'] ?? 0) === titleBefore
  && (eventDelta['session/title'] ?? 0) === 0
  && (eventDelta['session/title-llm-request'] ?? 0) === 0, eventDelta)
check('no goal, retry, command or queue record was written',
  (eventDelta['goal/change'] ?? 0) === 0
  && !Object.keys(eventDelta).some(type => type.startsWith('llm/retry'))
  && (eventDelta['command/run'] ?? 0) === 0
  && (eventDelta['agent/inbox/spliced'] ?? 0) === 0, eventDelta)
check('the only log change was the note itself',
  Object.keys(eventDelta).join(',') === 'reaction/note', eventDelta)
check('the note joined no transcript surface (nothing to render)',
  !after.surfaceNodes.includes(appended.seq)
  && JSON.stringify(after.surfaceNodes) === JSON.stringify(before.surfaceNodes),
  { surfaceBefore: before.surfaceNodes.length, surfaceAfter: after.surfaceNodes.length })
check('the host derived history did carry the note, as one plugin-sourced user line',
  after.derivedTexts.length === before.derivedTexts.length + 1
  && JSON.stringify(after.derivedTexts.slice(0, before.derivedTexts.length))
  === JSON.stringify(before.derivedTexts)
  && after.derivedTexts.at(-1).source.plugin === 'react-note'
  && after.derivedTexts.at(-1).id === `reaction-note-${appended.seq}`,
  after.derivedTexts.at(-1))

// A refusal path, measured once against the real host.
const refused = await rpcOutcome('session.react', { sessionId, targetSeq: 0, emoji: '👍' })
check('a non-message target is refused and appends nothing',
  refused.ok === false && refused.error.code === 'target-not-valid'
  && (await observe(sessionId)).events.length === after.events.length,
  refused)

// ── 2. POSITIVE: the NEXT turn's real request body ─────────────────────────
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn two: which one is closest' }] })
const afterSecond = await waitIdle(sessionId, { turnCount: 2 })
const calls = await readMock()
const secondRequest = calls.at(-1)
const secondMessages = secondRequest.body.messages ?? []
const notePlacement = indexesMatching(secondMessages, /reacted 👍/)

check('the second turn produced exactly one more model request',
  calls.length === mockBefore + 1, { before: mockBefore, after: calls.length })
check('the note reached the model exactly once, in the next request',
  notePlacement.length === 1, notePlacement)
check('the note sits at the tail of the request, after the conversation so far',
  notePlacement.length === 1 && notePlacement[0].index === secondMessages.length - 1,
  { index: notePlacement[0]?.index, messageCount: secondMessages.length })
check('the note is a user-role line naming the reaction and its target',
  notePlacement.length === 1
  && notePlacement[0].role === 'user'
  && wireText(secondMessages[notePlacement[0].index])
    === `owen reacted 👍 to the message at seq ${targetSeq}.`,
  secondMessages[notePlacement[0]?.index])

// Everything before the note is the turn's own content, unchanged: the same
// messages the first request carried plus the assistant reply and this prompt.
const firstMessages = calls[0].body.messages ?? []
const conversationOfSecond = secondMessages.filter((_, index) => index !== notePlacement[0]?.index)
check('the note is the ONLY addition to the second request',
  conversationOfSecond.length === firstMessages.length + 2
  && JSON.stringify(conversationOfSecond.slice(0, firstMessages.length))
  === JSON.stringify(firstMessages),
  { first: firstMessages.length, second: conversationOfSecond.length })

results.secondTurnRequest = {
  model: secondRequest.body.model,
  messageCount: secondMessages.length,
  noteIndex: notePlacement[0]?.index,
  messages: secondMessages.map((message, index) => ({
    index,
    role: message.role,
    content: message.content,
  })),
}

// ── 3. COMPACTION: no reaction text in the summary or the checkpoint ───────
// A slash command is a CLIENT-side decision: the browser calls the typert
// remote `commands/execute`, never `session.prompt` (which would send '/compact'
// to the model as text). Drive the same remote the browser drives.
let compaction
try {
  const noteSeq = appended.seq
  const callsBeforeCompact = (await readMock()).length

  // Grow the conversation so the compaction window spans the note's seq.
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn three: and the oldest' }] })
  await waitIdle(sessionId, { turnCount: 3 })
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn four: thank you' }] })
  const afterFourth = await waitIdle(sessionId, { turnCount: 4 })
  const callsBeforeCommand = (await readMock()).length

  const command = await rpc('commands/execute', { args: { agentId: sessionId, line: '/compact', images: [] } })
  const afterCompact = await waitIdle(sessionId)
  const compactionEvents = Object.fromEntries(Object.entries(afterCompact.eventCounts)
    .filter(([type]) => type.startsWith('compaction/')))
  const callsAfterCompact = await readMock()
  const compactionCalls = callsAfterCompact.slice(callsBeforeCommand)
  const summaries = afterCompact.events.filter(event => event.type === 'compaction/summary')
  const span = summaries.map(event => event.data?.shadowedRange)
  const shadowedSeqs = summaries.flatMap(event => event.data?.shadowedSeqs ?? [])

  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn five: after compaction' }] })
  const afterFifth = await waitIdle(sessionId, { turnCount: 5 })
  const fifthMessages = (await readMock()).at(-1).body.messages ?? []
  const fifthText = JSON.stringify(fifthMessages)
  // The durable checkpoint the model reads on every later request is the
  // replacement message carrying the summary.
  const checkpoint = afterFifth.derivedTexts.find(message => message.text.includes('<compacted-summary>'))

  compaction = {
    command: command.result?.text ?? null,
    callsBeforeCompact,
    callsDuringCompaction: callsAfterCompact.length - callsBeforeCommand,
    spans: span,
    noteSeq,
    // The span the summary replaced, and the note's position in it: the note's
    // seq lies INSIDE the compacted range (so the compaction genuinely spanned
    // it) and is NOT one of the shadowed surface nodes (so no summariser saw it).
    noteInsideCompactedRange: span.some(range => range !== undefined
      && range.start <= noteSeq && noteSeq <= range.end),
    noteAmongShadowedSeqs: shadowedSeqs.includes(noteSeq),
    shadowedSeqCount: shadowedSeqs.length,
    compactionEvents,
    summarizationRequestCarriedReactionText: compactionCalls
      .some(call => /reacted 👍|reaction/.test(JSON.stringify(call.body))),
    summarizationCallCount: compactionCalls.length,
    checkpointText: checkpoint?.text ?? null,
    checkpointCarriedReactionText: checkpoint !== undefined && /reacted|reaction/.test(checkpoint.text),
    noteInPostCompactionRequest: /reacted 👍/.test(fifthText),
    postCompactionMessages: fifthMessages.map((message, index) => ({
      index,
      role: message.role,
      content: JSON.stringify(message.content).slice(0, 240),
    })),
  }
  check('the /compact command reported a compaction',
    /Compacted \d+ history items/.test(compaction.command ?? ''), compaction.command)
  check('the compaction span was logged', span.length > 0, span)
  check('the compaction range did span the note', compaction.noteInsideCompactedRange, {
    span,
    noteSeq,
  })
  check('the note was not a shadowed surface node of the compaction',
    !compaction.noteAmongShadowedSeqs, { shadowedSeqs, noteSeq })
  check('the summarization request carried no reaction text',
    !compaction.summarizationRequestCarriedReactionText, compaction.summarizationCallCount)
  check('the durable checkpoint carried no reaction text',
    !compaction.checkpointCarriedReactionText, checkpoint?.text?.slice(0, 300))
  check('the note still reaches the model after the compaction',
    compaction.noteInPostCompactionRequest, compaction.postCompactionMessages)
} catch (error) {
  compaction = { error: String(error?.message ?? error) }
  failures.push(`compaction measurement failed: ${compaction.error}`)
}
results.compaction = compaction

// ── 4. Dump ────────────────────────────────────────────────────────────────
const dump = {
  sessionId,
  targetSeq,
  results,
  failures,
  finalObservation: await observe(sessionId),
  mockRequestCount: (await readMock()).length,
}
await writeFile(`${outDir}/react-note-drive.json`, JSON.stringify(dump, null, 2))
console.log(JSON.stringify({
  summary: Object.fromEntries(Object.entries(results)
    .filter(([key]) => key !== 'secondTurnRequest' && key !== 'compaction')
    .map(([key, value]) => [key, value.ok])),
  noteIndexInSecondRequest: results.secondTurnRequest?.noteIndex ?? null,
  compaction: {
    command: compaction.command ?? null,
    spans: compaction.spans ?? null,
    summarizationCallCount: compaction.summarizationCallCount ?? null,
  },
  failures,
  out: `${outDir}/react-note-drive.json`,
}, null, 2))
if (failures.length > 0) process.exitCode = 1
