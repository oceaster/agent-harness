/**
 * Observation-only host plugin for the reaction-note fixture.
 *
 * The append path under measurement is the REAL `session.react` RPC — this
 * plugin never writes. It exists because three of the facts the ticket asks for
 * are only visible from inside the running host: the exact event-type delta a
 * note appends, the agent's run state and inbox depth, and the message list
 * `Session.deriveMessages()` hands the loop. The request bodies the mock
 * provider recorded are the other half of that evidence.
 *
 *   GET /react-note-observe?sessionId=<id>
 *     → agentStatus, inbox, eventCounts, events[{seq,type}], surfaceNodes,
 *       derivedTexts, reactionNotes, projections
 *
 * `derivedTexts` is the model-bound history (the array the agent loop hands the
 * provider): a reaction note must never appear in it, at any index.
 * `reactionNotes` is the UI projection (`Session.reactionNotes()`): the notes
 * still shown on the message they target.
 *
 * Mounted as a home-level patch row by start-react-note-fixture.sh, so no
 * product file is touched.
 */

export const name = 'react-note-observe'
export const inject = ['sessions', 'agents', 'webServer']

/** Count events by type, so a diff of two observations shows every appending path. */
function countTypes(events) {
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

/** The model-facing view of one derived message. */
function messageTexts(messages) {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    source: message.source,
    text: message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n'),
  }))
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/react-note-observe',
    handler: async (req, res) => {
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      try {
        const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId')
        const agent = ctx.agents.get(sessionId)
        const session = agent?.session ?? ctx.sessions.get(sessionId)
        if (session === undefined) return reply(404, { error: 'no live session', sessionId })
        const derived = session.deriveMessages()
        const projections = ctx.get('sessionProjections')
        return reply(200, {
          agentStatus: agent?.status ?? null,
          inbox: agent === undefined
            ? null
            : { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length },
          eventCounts: countTypes(session.events),
          events: session.events.map(event => ({
            seq: event.seq,
            type: event.type,
            ignorable: event.ignorable === true,
            // Payloads only where the measurement reads them: the note's own
            // fields, and the compaction summary's span.
            ...(event.type === 'reaction/note' ? { data: event.data } : {}),
            ...(event.type === 'compaction/summary'
              ? { data: { shadowedRange: event.data.shadowedRange, shadowedSeqs: event.data.shadowedSeqs } }
              : {}),
          })),
          surfaceNodes: [...session.surface.nodes],
          derivedTexts: messageTexts(derived),
          reactionNotes: session.reactionNotes().map(event => ({ seq: event.seq, data: event.data })),
          projections: projections === undefined
            ? null
            : (() => {
              const cut = projections.snapshot(session)
              return { asOfSeq: cut.asOfSeq, keys: Object.keys(cut.values) }
            })(),
        })
      } catch (error) {
        return reply(500, { error: String(error?.stack ?? error) })
      }
    },
  }), 'react-note-observe: /react-note-observe route')
}
