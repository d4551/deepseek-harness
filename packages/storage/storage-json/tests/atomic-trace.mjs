import { createTracing } from 'node:trace_events'
import { writeAtomic } from '../src/atomic.ts'

const target = process.argv[2]
if (target === undefined) throw new Error('An atomic publication target is required.')

await writeAtomic(target, 'previously published')

const tracing = createTracing({ categories: ['node.fs.async'] })
tracing.enable()
try {
  await writeAtomic(target, 'durably published')
} finally {
  tracing.disable()
}
