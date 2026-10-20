/**
 * Spike probe (ticket 5ef4e080) — NOT product source.
 *
 * Drives the keyless `dsh web` fixture (start-react-note-fixture.sh) and
 * measures the two things the ticket says cannot be answered by reading:
 *
 *   NEGATIVE — appending a reaction note from outside the agent loop starts
 *   nothing: no turn, no model request, no running state, no queue entry, no
 *   title generation, no goal or retry record.
 *
 *   POSITIVE — what the model actually receives on the next ordinary turn,
 *   taken from the request body the mock provider recorded (not from a claim
 *   about which code path runs), plus where in the message list it sits.
 *
 * Both carriers are measured:
 *   'log-only'     — a new event kind with no surface marker (the shape Owen's
 *                    spec implies: durable, model-read, transcript-invisible).
 *   'user-message' — the only existing carrier that reaches the model today:
 *                    a user-role surface event with a plugin source.
 *
 * Usage: node probe.mjs <baseUrl> <outDir>
 * Exits non-zero when a measurement contradicts its expected shape.
 */
import { mkdir, writeFile } from 'node:fs/promises'

const [baseUrl, outDir = '/tmp/react-note-proof'] = process.argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: node probe.mjs <baseUrl> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

const results = {}
const failures = []
function check(name, condition, detail) {
  results[name] = { ok: Boolean(condition), detail }
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail)}`)
}

let rpcCounter = 0
async function rpc(method, payload) {
  const rpcId = `probe-${++rpcCounter}`
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

async function probe(path, init) {
  const response = await fetch(`${baseUrl}/react-note-probe${path}`, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}

const observe = sessionId => probe(`/observe?sessionId=${encodeURIComponent(sessionId)}`)

async function append(sessionId, mode, emoji, targetSeq) {
  return probe('/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, mode, emoji, targetSeq }),
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitIdle(sessionId, { turnCount, timeoutMs = 30_000 } = {}) {
  const started = Date.now()
  for (;;) {
    const snapshot = await observe(sessionId)
    const turns = snapshot.turnEnds.length
    if (snapshot.agentStatus === 'idle'
      && (turnCount === undefined || turns >= turnCount)) return snapshot
    if (Date.now() - started > timeoutMs) {
      throw new Error(`agent did not settle: ${JSON.stringify({ status: snapshot.agentStatus, turns })}`)
    }
    await sleep(100)
  }
}

const cwd = process.env.PROBE_CWD ?? '/tmp'

// ── 0. session, first ordinary turn ─────────────────────────────────────────
// 'code' is a shipped preset: it mounts compaction-basic and command-compact,
// which the web profile itself disables at host level, so /compact works here.
const created = await rpc('session.create', { cwd, agentPreset: 'code' })
const sessionId = created.sessionId
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn one: say hello' }] })
const afterFirst = await waitIdle(sessionId, { turnCount: 1 })

// The mock provider's recording is served by the mock process; the fixture
// writes it to the fixture dir, so read it through the driver's own helper.
async function readMock() {
  const response = await fetch(`${mockUrl}/__requests`)
  if (!response.ok) throw new Error(`mock /__requests HTTP ${response.status}`)
  return response.json()
}
const mockUrl = process.env.MOCK_URL ?? 'http://127.0.0.1:3588'

const baseline = {
  observation: afterFirst,
  mockCalls: (await readMock()).length,
}
// The first prompt also triggers the title provider's own auxiliary call, so
// the baseline is two requests: one conversation request, one title request.
const firstCalls = await readMock()
const titleCall = firstCalls.find(call => JSON.stringify(call.body).includes('Generate the session title'))
check('first turn produced one conversation call plus one title call',
  baseline.mockCalls === 2 && titleCall !== undefined,
  { mockCalls: baseline.mockCalls, titleCall: titleCall !== undefined })

// ── 1. NEGATIVE: append a log-only reaction note ────────────────────────────
const beforeAppend = await observe(sessionId)
const beforeMock = (await readMock()).length
const appended = await append(sessionId, 'log-only', '👍', 0)
// Give every plausible async wake (driver latch, title provider, projection
// push, goal round driver) a generous window to move before asserting nothing did.
await sleep(3000)
const afterAppend = await observe(sessionId)
const afterMock = (await readMock()).length

const countDelta = (before, after) => {
  const delta = {}
  for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[type] ?? 0) - (before[type] ?? 0)
    if (change !== 0) delta[type] = change
  }
  return delta
}
const eventDelta = countDelta(beforeAppend.eventCounts, afterAppend.eventCounts)

check('append landed as a log-only event', appended.type === 'reaction/note'
  && eventDelta['reaction/note'] === 1, { appended, eventDelta })
check('no model call after the note', afterMock === beforeMock, { beforeMock, afterMock })
check('agent stayed idle', afterAppend.agentStatus === 'idle', afterAppend.agentStatus)
check('inbox stayed empty', afterAppend.inbox.nextTurn === 0 && afterAppend.inbox.nextStep === 0, afterAppend.inbox)
check('no turn or step boundary opened', (eventDelta['turn/start'] ?? 0) === 0
  && (eventDelta['step/start'] ?? 0) === 0, eventDelta)
check('no title event was generated', (eventDelta['session/title'] ?? 0) === 0
  && (eventDelta['session/title-llm-request'] ?? 0) === 0, eventDelta)
check('no goal, retry, command or inbox record was written', (eventDelta['goal/change'] ?? 0) === 0
  && !Object.keys(eventDelta).some(type => type.startsWith('llm/retry'))
  && (eventDelta['command/run'] ?? 0) === 0
  && (eventDelta['agent/inbox/spliced'] ?? 0) === 0, eventDelta)
check('the only log change was the note itself', Object.keys(eventDelta).join(',') === 'reaction/note', eventDelta)
check('model history unchanged by the append', JSON.stringify(afterAppend.derivedTexts)
  === JSON.stringify(beforeAppend.derivedTexts), {
  before: beforeAppend.derivedTexts.length,
  after: afterAppend.derivedTexts.length,
})
check('projected model history does not carry the note', !afterAppend.derivedTexts
  .some(message => message.text.includes('[reaction-note]')), afterAppend.derivedTexts)

// ── 2. POSITIVE: the next ordinary turn's real request body ─────────────────
await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn two: what changed?' }] })
const afterSecond = await waitIdle(sessionId, { turnCount: 2 })
const calls = await readMock()
const secondRequest = calls.at(-1)
const secondMessages = secondRequest.body.messages ?? []
const noteInSecond = secondMessages
  .map((message, index) => ({ index, role: message.role, content: JSON.stringify(message.content) }))
  .filter(message => message.content.includes('[reaction-note]'))

check('the second turn produced exactly one more model call', calls.length === 3, { calls: calls.length })
check('the log-only note is ABSENT from the model request', noteInSecond.length === 0, {
  noteInSecond,
  messageCount: secondMessages.length,
})
results.secondTurnRequest = {
  model: secondRequest.body.model,
  messageCount: secondMessages.length,
  messages: secondMessages,
  modelInputFromHost: afterSecond.derivedTexts,
}

// ── 3. The alternative carrier: a user-role surface event ───────────────────
const beforeUserAppend = await observe(sessionId)
const beforeUserMock = (await readMock()).length
const appendedUser = await append(sessionId, 'user-message', '🎉', 2)
await sleep(3000)
const afterUserAppend = await observe(sessionId)
const afterUserMock = (await readMock()).length
const userDelta = countDelta(beforeUserAppend.eventCounts, afterUserAppend.eventCounts)

check('user-message carrier landed', appendedUser.type === 'user/message', appendedUser)
check('user-message carrier starts no model call either', afterUserMock === beforeUserMock, {
  beforeUserMock,
  afterUserMock,
})
check('user-message carrier writes no turn boundary', (userDelta['turn/start'] ?? 0) === 0
  && (userDelta['step/start'] ?? 0) === 0, userDelta)
check('user-message carrier stays idle with an empty inbox', afterUserAppend.agentStatus === 'idle'
  && afterUserAppend.inbox.nextTurn === 0 && afterUserAppend.inbox.nextStep === 0, {
  status: afterUserAppend.agentStatus,
  inbox: afterUserAppend.inbox,
})

await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn three' }] })
const afterThird = await waitIdle(sessionId, { turnCount: 3 })
const thirdMessages = (await readMock()).at(-1).body.messages ?? []
const userNotePlacement = thirdMessages
  .map((message, index) => ({ index, role: message.role, content: JSON.stringify(message.content) }))
  .filter(message => message.content.includes('[reaction-note]'))

check('the user-message carrier DOES reach the model', userNotePlacement.length === 1, userNotePlacement)
results.thirdTurnRequest = {
  messageCount: thirdMessages.length,
  notePlacement: userNotePlacement.map(entry => ({ index: entry.index, role: entry.role })),
  messages: thirdMessages.map((message, index) => ({ index, role: message.role, content: message.content })),
  modelInputFromHost: afterThird.derivedTexts,
}

// ── 4. Compaction: does a note survive a summary? ───────────────────────────
// Slash commands are a CLIENT-side decision: the browser calls the typert
// remote `commands/execute`, never `session.prompt`. The probe therefore calls
// the same remote the browser calls (named-args payload), not a '/compact'
// prompt — which the model would simply receive as text.
let compaction
try {
  const beforeCompact = await observe(sessionId)
  const compactCallsBefore = (await readMock()).length
  const compactOutcome = await rpc('commands/execute', {
    args: { agentId: sessionId, line: '/compact', images: [] },
  })
  await waitIdle(sessionId)
  const afterCompact = await observe(sessionId)
  const compactionEvents = Object.fromEntries(Object.entries(afterCompact.eventCounts)
    .filter(([type]) => type.startsWith('compaction/')))
  const callsAfterCompact = await readMock()
  const compactCallDelta = callsAfterCompact.length - compactCallsBefore
  const summarizationCall = callsAfterCompact.slice(compactCallsBefore)
    .find(call => JSON.stringify(call.body).includes('Summarize') || JSON.stringify(call.body).includes('summary'))
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'turn four: after compaction' }] })
  const afterFourth = await waitIdle(sessionId, { turnCount: 4 })
  const fourthRequest = (await readMock()).at(-1)
  const fourthMessages = fourthRequest.body.messages ?? []
  const joined = JSON.stringify(fourthMessages)
  compaction = {
    command: compactOutcome.result?.text ?? null,
    modelCallsDuringCompaction: compactCallDelta,
    compactionEvents,
    summarizationPromptCarriedNote: summarizationCall === undefined
      ? null
      : JSON.stringify(summarizationCall.body).includes('[reaction-note]'),
    // The two carriers use distinct emoji; JSON escapes them as surrogate
    // pairs, so compare the decoded emoji rather than the wire text.
    logOnlyNoteInNextRequest: fourthMessages.some(message => JSON.stringify(message.content)
      .includes('👍')),
    userMessageNoteInNextRequest: fourthMessages.some(message => JSON.stringify(message.content)
      .includes('🎉')),
    noteMarkerCountInNextRequest: (joined.match(/reaction-note/g) ?? []).length,
    turnsBefore: beforeCompact.turnEnds.length,
    turnsAfter: afterCompact.turnEnds.length,
    noteInHostDerivedHistory: afterFourth.derivedTexts.some(message => message.text.includes('[reaction-note]')),
    checkpointText: afterFourth.derivedTexts
      .map(message => message.text)
      .find(text => text.includes('condensing an earlier span'))?.slice(0, 800) ?? null,
    noteInNextRequest: joined.includes('[reaction-note]'),
    postCompactionMessages: fourthMessages.map((message, index) => ({
      index,
      role: message.role,
      content: JSON.stringify(message.content).slice(0, 400),
    })),
    modelInputFromHost: afterFourth.derivedTexts,
  }
  check('compaction events were logged', Object.keys(compactionEvents).length > 0, compactionEvents)
  check('the /compact command reported a compaction', /Compacted \d+ history items/.test(compaction.command ?? ''), compactOutcome)
} catch (error) {
  compaction = { error: String(error?.message ?? error) }
  failures.push(`compaction measurement failed: ${compaction.error}`)
}
results.compaction = compaction

// ── 5. Dump ─────────────────────────────────────────────────────────────────
const dump = {
  sessionId,
  results,
  failures,
  finalObservation: await observe(sessionId),
  mockRequestCount: (await readMock()).length,
}
await writeFile(`${outDir}/react-note-probe.json`, JSON.stringify(dump, null, 2))
console.log(JSON.stringify({ summary: Object.fromEntries(Object.entries(results)
  .filter(([key]) => !key.endsWith('Request') && key !== 'compaction')
  .map(([key, value]) => [key, value.ok])), failures, out: `${outDir}/react-note-probe.json` }, null, 2))
if (failures.length > 0) process.exitCode = 1
