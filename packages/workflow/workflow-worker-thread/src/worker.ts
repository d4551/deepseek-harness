/**
 * Single-statement worker entry that boots `runWorkerSession` on real `parentPort`. Logic remains in
 * the session module for in-process MessageChannel coverage; importing this entry on the main thread
 * exercises `requireParentPort`'s failure path.
 * @module @deepseek-ai/dsh-workflow-worker-thread/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { requireParentPort, runWorkerSession } from './session.ts'
import type { WorkerInit } from './types.ts'

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

// workerData is `any` at the node:worker_threads boundary; the engine is the
// only spawner and always provides a WorkerInit.
function failWorker(error: Thrown): never {
  console.error(error)
  process.exit(1)
}

runWorkerSession(requireParentPort(parentPort), workerData as WorkerInit).then(undefined, failWorker)
