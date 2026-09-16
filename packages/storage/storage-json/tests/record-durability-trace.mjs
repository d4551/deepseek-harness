import { createTracing } from 'node:trace_events'
import { JsonStorageBackend } from '../src/index.ts'

const root = process.argv[2]
const operation = process.argv[3]
if (root === undefined || (operation !== 'create' && operation !== 'delete')) {
  throw new Error('A storage root and create/delete operation are required.')
}
const backend = new JsonStorageBackend(root)
const descriptor = { name: 'records', version: 1, tables: ['items'], hasGlobal: false, layout: 'per-record' }
const tracing = createTracing({ categories: ['node.fs.async'] })
try {
  if (operation === 'create') {
    tracing.enable()
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('items', 'saved', true)
  } else {
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('items', 'saved', true)
    tracing.enable()
    await unit.deleteRecord('items', 'saved')
  }
} finally {
  tracing.disable()
  await backend.close()
}
