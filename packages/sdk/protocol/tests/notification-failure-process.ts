import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { JsonRpcLineTransport } from '../src/transport.ts'

const mode = process.argv[2]
if (mode !== 'throw' && mode !== 'reject') throw new Error('notification failure mode is required')
const input = new PassThrough()
const output = new PassThrough()
const written: string[] = []
output.setEncoding('utf8')
output.on('data', (chunk: string) => { written.push(chunk) })
const transport = new JsonRpcLineTransport(input, output)
const failure = new Error(`notification ${mode}`)
transport.onNotification(mode === 'throw'
  ? () => { throw failure }
  : async () => { await setImmediate(); throw failure })
transport.start()
const pending = Promise.allSettled([transport.request('pending', {})])
input.write('{"jsonrpc":"2.0","method":"fail"}\n')
const [closed, [outcome]] = await Promise.all([transport.closed, pending])
if (closed !== failure) throw new Error('close outcome lost notification failure identity')
if (outcome.status !== 'rejected' || outcome.reason !== failure) {
  throw new Error('pending request lost notification failure identity')
}
await setImmediate()
process.stdout.write(`${JSON.stringify({ closed: closed.message, pending: failure.message, frames: written.length })}\n`)
