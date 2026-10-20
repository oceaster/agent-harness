import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'sse'; events: string[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: string[] }
  | { kind: 'listing'; body: string; status?: number; headers?: Record<string, string> }
  /** Accept the request and never answer it, so a caller can be observed not waiting. */
  | { kind: 'hang' }

/** One `GET /models` interrogation the mock server received. */
export interface ListingRequest {
  /** Request target, including any query. */
  url: string
  headers: IncomingMessage['headers']
}

export interface MockServer {
  url: string
  /** Bodies of received chat-completion requests, in order. */
  requests: unknown[]
  /** Header bags of received chat-completion requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  /** Model-listing interrogations, in order. */
  listingRequests: ListingRequest[]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/**
 * Close every server opened since the last call; run from each spec's afterEach.
 * Sockets are destroyed first: a scripted `hang` behavior leaves a request the
 * server would otherwise wait out, which would hang the spec instead.
 */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
}

/** A minimal complete text generation, reused by request-shape assertions. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
  '{"choices":[{"delta":{"content":"hello"}}]}',
  '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/**
 * Local chat-completions and model-listing stand-in: replays scripted behaviors
 * per request. Chat and listing requests draw from separate scripts, so a
 * background catalog refresh cannot disturb a scripted chat conversation; an
 * unscripted listing request answers 404, the gateway-without-the-route case.
 */
export async function mockServer(script: Behavior[], listingScript: Behavior[] = []): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const listingRequests: ListingRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      if (request.method === 'GET') {
        listingRequests.push({ url: request.url ?? '', headers: request.headers })
        const behavior = listingScript.shift()
        if (behavior?.kind === 'listing') {
          response.writeHead(behavior.status ?? 200, {
            'content-type': 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        if (behavior?.kind === 'http-error') {
          response.writeHead(behavior.status, {
            'content-type': behavior.contentType ?? 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        if (behavior?.kind === 'hang') return
        response.writeHead(404).end('{"error":{"message":"no models route"}}')
        return
      }
      const behavior = script.shift()
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      if (!behavior) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      if (behavior.kind === 'http-error') {
        response.writeHead(behavior.status, {
          'content-type': behavior.contentType ?? 'application/json',
          ...behavior.headers,
        })
        response.end(behavior.body)
        return
      }
      if (behavior.kind !== 'sse' && behavior.kind !== 'close-early') {
        response.writeHead(500).end(`unscripted ${behavior.kind} behavior for a chat request`)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const write = (index: number): void => {
        if (index >= behavior.events.length) {
          if (behavior.kind === 'sse') response.end()
          else response.destroy() // close-early: drop the socket mid-stream
          return
        }
        response.write(`data: ${behavior.events[index]}\n\n`)
        setTimeout(() => { write(index + 1) }, behavior.kind === 'sse' ? behavior.delayMs ?? 0 : 5)
      }
      write(0)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    listingRequests,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
