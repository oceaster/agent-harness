/**
 * Keyless OpenAI-compatible provider for the reaction-note fixture.
 *
 * Records every chat-completion request body it is handed and answers with one
 * canned generation, so a measured "what the model received" is the real
 * request the harness assembled rather than a claim about which code path ran.
 * The SSE payload lines are copied verbatim from the repo's own provider
 * fixture (`packages/llm/llm-deepseek/tests/mock-server.ts`, `textEvents`).
 *
 * A reply that mentions reaction text when it sees one is deliberate: if a
 * reaction note ever reached a summarization request, the summary the model
 * writes would carry it into the durable checkpoint, and the driver's
 * "no reaction text in the checkpoint" assertion would catch it instead of
 * passing on a summary that simply never looked.
 *
 *   POST /chat/completions  → text/event-stream, one canned reply
 *   GET  /models            → 404 (catalog lookups stay advisory/static)
 *   GET  /__requests        → the recorded request bodies, in order
 *   POST /__reset           → drop the recording
 *
 * Usage: node mock-llm.mjs <port> <outFile>
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const [port, outFile] = process.argv.slice(2)
if (port === undefined || outFile === undefined) {
  console.error('usage: node mock-llm.mjs <port> <outFile>')
  process.exit(2)
}

/** Recorded chat-completion request bodies, in arrival order. */
const requests = []

/** Flush the recording so a shell step can read it even if the server lives on. */
function flush() {
  writeFileSync(outFile, JSON.stringify(requests, null, 2))
}
flush()

/** One complete text generation, verbatim from the repo's provider fixture. */
function textEvents(text) {
  return [
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    `{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`,
    '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    '[DONE]',
  ]
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/__requests')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(requests, null, 2))
    return
  }
  if (req.method === 'POST' && req.url?.startsWith('/__reset')) {
    requests.length = 0
    flush()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"reset":true}')
    return
  }
  if (req.method === 'GET') {
    // No catalog route: the provider falls back to its built-in advisory list.
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"no models route"}}')
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk.toString('utf8') })
  req.on('end', () => {
    let parsed = body
    try {
      parsed = JSON.parse(body)
    } catch { /* recording the raw text is the honest outcome */ }
    requests.push({ at: Date.now(), url: req.url, body: parsed })
    flush()
    const index = requests.length
    const serialized = JSON.stringify(parsed)
    // Only a COMPACTION request echoes what it was shown. An ordinary turn must
    // answer with plain text, or the mock's own replies would carry reaction
    // text into later requests and pollute the measurement it is meant to make.
    const isCompaction = /compaction engine|Condense the conversation/.test(serialized)
    const reaction = isCompaction
      ? serialized.match(/(?:[a-z]+ reacted|removed their|changed their reaction)[^"\\]*/)
      : null
    const reply = reaction === null
      ? `mock assistant reply ${index}`
      : `condensed from history: ${reaction[0]}`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of textEvents(reply)) {
      res.write(`data: ${event}\n\n`)
    }
    res.end()
  })
})

server.listen(Number(port), '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: Number(port) }))
})
