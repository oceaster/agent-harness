/**
 * Restart half of the reaction-note fixture (ticket f1bdaed3).
 *
 * Acceptance 2 is a restart: append a note, stop the host, start the SAME build
 * on the SAME DSH_HOME, and show the conversation still opens with the note
 * still in its log. `restart-check.sh` does the stop/start; this script does the
 * asking, through the same client-request carrier the browser uses.
 *
 * What it proves, against the real built harness:
 *   1. `session.history` reads the restarted log and it still holds the note,
 *      with its envelope `ignorable` marker;
 *   2. the conversation OPENS — a second `session.react` resumes the cold
 *      session (the shared `agentFor` path) and lands a new note, so the log was
 *      interpretable rather than refused;
 *   3. the UI projection survives the restart: `Session.reactionNotes()`
 *      reports both notes, in log order, each naming its target — while the
 *      model-bound history (`Session.deriveMessages()`) carries neither, before
 *      or after the restart.
 *
 * Usage: node restart-check.mjs <baseUrl> <sessionId> <outDir>
 */
import { mkdir, writeFile } from 'node:fs/promises'

const [baseUrl, sessionId, outDir = '/tmp/react-note-proof'] = process.argv.slice(2)
if (baseUrl === undefined || sessionId === undefined) {
  console.error('usage: node restart-check.mjs <baseUrl> <sessionId> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

const failures = []
function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail)}`)
  return { ok: Boolean(condition), detail }
}

let rpcCounter = 0
async function rpc(method, payload) {
  const rpcId = `restart-${++rpcCounter}`
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

async function observe(id) {
  const response = await fetch(`${baseUrl}/react-note-observe?sessionId=${encodeURIComponent(id)}`)
  const text = await response.text()
  if (!response.ok) throw new Error(`observe HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}

const results = {}

// ── 1. The restarted log still opens, and still holds the note ─────────────
const history = await rpc('session.history', { sessionId })
const events = (history.events ?? []).map(entry => entry.event ?? entry)
const notes = events.filter(event => event?.type === 'reaction/note')
results.historyReads = check('session.history reads the restarted log', events.length > 0, {
  events: events.length,
})
results.noteStillThere = check('the note is still in the log after the restart', notes.length === 1, {
  notes: notes.map(note => ({ seq: note.seq, ignorable: note.ignorable, data: note.data })),
})
results.noteMarked = check('the restarted note still carries ignorable: true',
  notes[0]?.ignorable === true, notes[0])

// ── 2. The conversation OPENS: a second note lands on the cold session ─────
const target = events.find(event => event?.type === 'user/message')
const second = await rpc('session.react', {
  sessionId, targetSeq: target.seq, emoji: '🎉', actor: 'owen', action: 'added',
})
const after = await observe(sessionId)
const noteEvents = after.events.filter(event => event.type === 'reaction/note')
results.conversationOpens = check('a cold session resumed and accepted a new note', second.seq > 0, second)
results.bothNotesInLog = check('both notes are in the log, in order',
  noteEvents.length === 2 && noteEvents[1].seq > noteEvents[0].seq, noteEvents)

// ── 3. The UI projection survived the restart, and the model still has none ─
const shown = after.reactionNotes ?? []
results.uiProjectionSurvives = check('the reopened session shows both notes, in log order',
  shown.length === 2
  && shown[0].seq === noteEvents[0].seq
  && shown[1].seq === noteEvents[1].seq
  && shown[0].data.targetSeq === target.seq
  && shown[0].data.emoji === '👍'
  && shown[1].data.emoji === '🎉',
  shown)
const modelFacing = after.derivedTexts.filter(message => message.source.plugin === 'react-note'
  || /reacted|reaction/.test(message.text)
  || String(message.id).startsWith('reaction-note-'))
results.modelHistoryCarriesNoNote = check('the reopened model history carries no note at any index',
  modelFacing.length === 0, after.derivedTexts)
results.noteNotOnSurface = check('the notes are still off the transcript surface',
  noteEvents.every(note => !after.surfaceNodes.includes(note.seq)), after.surfaceNodes.length)

const dump = { sessionId, results, failures, observation: after }
await writeFile(`${outDir}/react-note-restart.json`, JSON.stringify(dump, null, 2))
console.log(JSON.stringify({
  summary: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.ok])),
  failures,
  out: `${outDir}/react-note-restart.json`,
}, null, 2))
if (failures.length > 0) process.exitCode = 1
