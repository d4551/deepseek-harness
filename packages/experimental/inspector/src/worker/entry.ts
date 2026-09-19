/** Node Worker bootstrap for the experimental Inspector. */

import { MessagePort, parentPort, workerData } from 'node:worker_threads'
import type { InspectorWorkerBoot, InspectorWorkerControl } from '../shared/bridge/messages/control.ts'
import { parseInspectorHostControl, parseInspectorWorkerConfig } from '../shared/bridge/control-codec.ts'
import { isPlainObject } from '../shared/json.ts'
import { startInspectorWorker } from './server.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

if (parentPort === null) throw new Error('experimental inspector: Worker entry loaded on the main thread')
const controlPort = parentPort

const bootData = workerData as unknown
if (!isPlainObject(bootData)
  || !(bootData.hostSourcePort instanceof MessagePort)) {
  throw new Error('experimental inspector: invalid Worker boot data')
}
const boot: InspectorWorkerBoot<MessagePort> = {
  hostSourcePort: bootData.hostSourcePort,
  config: parseInspectorWorkerConfig(bootData.config),
}

let runtime: Awaited<ReturnType<typeof startInspectorWorker>> | undefined
let stopping: Promise<void> | undefined

const stop = (): Promise<void> => {
  stopping ??= (async () => {
    await runtime?.close()
    controlPort.postMessage({ type: 'stopped' } satisfies InspectorWorkerControl)
    controlPort.close()
  })()
  return stopping
}

const reportFailure = (error: unknown): void => {
  controlPort.postMessage({
    type: 'failure',
    message: error instanceof Error ? error.message : String(error),
  } satisfies InspectorWorkerControl)
}

controlPort.on('message', (message: unknown) => {
  try {
    parseInspectorHostControl(message)
    stop().then(undefined, (error: Thrown) => { reportFailure(error) })
  } catch (error) {
    reportFailure(error)
  }
})

await startInspectorWorker(boot).then(
  (started) => {
    runtime = started
    controlPort.postMessage({ type: 'ready', ...runtime.endpoint } satisfies InspectorWorkerControl)
  },
  async (error: Thrown) => {
    reportFailure(error)
    await stop()
  },
)
