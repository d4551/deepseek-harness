import { createInterface } from 'node:readline'

const reader = createInterface({ input: process.stdin })
const heartbeat = setInterval(() => { process.stderr.write('protocol peer remains live\n') }, 1_000)
process.on('SIGTERM', () => {
  clearInterval(heartbeat)
  reader.close()
  process.exit(0)
})
process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ready', params: { pid: process.pid } })}\n`)
reader.on('line', (line) => {
  const frame: unknown = JSON.parse(line)
  if (frame === null || typeof frame !== 'object') throw new Error('peer request is not an object')
  const id: unknown = Reflect.get(frame, 'id')
  const method: unknown = Reflect.get(frame, 'method')
  if (typeof id !== 'string' || typeof method !== 'string') throw new Error('peer request is missing its identity')
  if (method === 'close-output') {
    process.stdout.end(`${JSON.stringify({ jsonrpc: '2.0', id, result: { closing: true } })}\n`)
  } else if (method === 'end-during-request') {
    process.stdout.end()
  } else throw new Error(`unexpected peer request: ${method}`)
})
