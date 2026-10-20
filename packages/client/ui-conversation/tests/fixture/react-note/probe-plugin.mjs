/**
 * Spike probe (ticket 5ef4e080) — NOT product source.
 *
 * A host-side cordis plugin mounted only by the keyless `dsh web` fixture in
 * this directory. It answers three questions the running host can answer and
 * a static read cannot:
 *
 *   1. POST /react-note-probe/append  — append one event to a live session from
 *      outside the agent loop (the shape the reaction RPC would take) and
 *      report the seq it landed at.
 *   2. GET  /react-note-probe/observe — read everything that could have moved
 *      as a side effect: agent status, inbox depth, turn/step boundaries,
 *      title events, goal events, event-type counts, the derived model
 *      history, and the session-projection watermark.
 *   3. GET  /react-note-probe/model-input — the exact message list
 *      `Session.deriveMessages()` hands the loop for the next request.
 *
 * The companion `probe.mjs` drives these over HTTP and compares them with the
 * request bodies the mock provider actually received.
 */

export const name = 'react-note-probe'
export const inject = ['sessions', 'agents', 'webServer']

/** Reaction note text, kept in one place so every dump can be grepped for it. */
export const NOTE_PREFIX = '[reaction-note]'

function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body === '' ? {} : JSON.parse(body)
}

function liveAgent(ctx, sessionId) {
  return ctx.agents.get(sessionId)
}

function liveSession(ctx, sessionId) {
  return liveAgent(ctx, sessionId)?.session ?? ctx.sessions.get(sessionId)
}

/** Count events by type so a diff of two observations shows every appending path. */
function countTypes(events) {
  const counts = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

function messageTexts(messages) {
  return messages.map(message => ({
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
    path: '/react-note-probe',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice('/react-note-probe'.length)
      try {
        if (route === '/append' && req.method === 'POST') {
          const body = await readBody(req)
          const session = liveSession(ctx, body.sessionId)
          if (session === undefined) return reply(res, 404, { error: 'no live session', sessionId: body.sessionId })
          const emoji = body.emoji ?? '👍'
          const targetSeq = body.targetSeq ?? -1
          const text = `${NOTE_PREFIX} ${emoji} on message seq ${targetSeq}`
          if (body.mode === 'user-message') {
            // The alternative carrier: an ordinary user-role surface event with
            // a plugin source, i.e. the exact message `createUserMessage()` in
            // @deepseek-ai/dsh-llm builds (id + role + content + source) —
            // constructed inline because this fixture file sits outside the
            // package's own module resolution paths.
            const message = {
              id: crypto.randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: 'react-note' },
            }
            const event = session.append('user/message', message, { surfaceOp: 'append' })
            return reply(res, 200, { seq: event.seq, type: event.type, text })
          }
          // The log-only carrier: a kind outside core's surface-eligible set.
          // No surfaceOp is passed, and the surface contract forbids one.
          const event = session.append('reaction/note', {
            emoji,
            targetSeq: Number(targetSeq),
            actor: body.actor ?? 'owner',
            action: body.action ?? 'added',
            text,
          })
          return reply(res, 200, { seq: event.seq, type: event.type, text })
        }

        if (route === '/observe') {
          const sessionId = url.searchParams.get('sessionId')
          const agent = liveAgent(ctx, sessionId)
          const session = liveSession(ctx, sessionId)
          if (session === undefined) return reply(res, 404, { error: 'no live session', sessionId })
          const derived = session.deriveMessages()
          const projections = ctx.get('sessionProjections')
          return reply(res, 200, {
            agentStatus: agent?.status ?? null,
            inbox: agent === undefined
              ? null
              : { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length },
            lastSeq: session.events.at(-1)?.seq ?? -1,
            eventCounts: countTypes(session.events),
            turnEnds: session.events
              .filter(event => event.type === 'turn/end')
              .map(event => ({ seq: event.seq, reason: event.data.reason })),
            titleEvents: session.events
              .filter(event => event.type === 'session/title')
              .map(event => ({ seq: event.seq, title: event.data.title, source: event.data.source })),
            goalEvents: session.events.filter(event => event.type === 'goal/change').length,
            retryEvents: session.events.filter(event => event.type.startsWith('llm/retry')).length,
            derivedMessageCount: derived.length,
            derivedTexts: messageTexts(derived),
            projections: projections === undefined
              ? null
              : (() => {
                const cut = projections.snapshot(session)
                return { asOfSeq: cut.asOfSeq, keys: Object.keys(cut.values) }
              })(),
          })
        }

        if (route === '/model-input') {
          const sessionId = url.searchParams.get('sessionId')
          const session = liveSession(ctx, sessionId)
          if (session === undefined) return reply(res, 404, { error: 'no live session', sessionId })
          const derived = session.deriveMessages()
          return reply(res, 200, {
            messages: messageTexts(derived),
            // The full derived list is what the loop serializes into the request.
            raw: derived,
          })
        }

        return reply(res, 404, { error: 'unknown probe route', route })
      } catch (error) {
        return reply(res, 500, { error: String(error?.stack ?? error) })
      }
    },
  }), 'react-note-probe: /react-note-probe routes')
}
