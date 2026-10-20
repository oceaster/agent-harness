/**
 * Spike probe (part 3): drive the host RPC over loopback, no browser.
 * Usage: node rpc.mjs <baseUrl> <method> [jsonPayload]
 */
const [baseUrl, method, payloadJson = '{}'] = process.argv.slice(2)
const rpcId = `spike-${Math.random().toString(16).slice(2)}`
const response = await fetch(`${baseUrl}/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId, method, payload: JSON.parse(payloadJson) }),
})
const full = await response.json()
console.log(JSON.stringify({ httpStatus: response.status, rpcIdMatches: full.rpcId === rpcId, result: full.result }, null, 2))
