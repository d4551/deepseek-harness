/**
 * Differential check of the worker's implemented crypto/url/util built-ins against Node.
 */
import { expect, test } from 'vitest'
import { createHash as nodeCreateHash } from 'node:crypto'
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from 'node:url'
import { isDeepStrictEqual as nodeIsDeepStrictEqual, promisify as nodePromisify } from 'node:util'
import * as workerCrypto from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/crypto.ts'
import * as workerUrl from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/url.ts'
import * as workerUtil from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/util.ts'

/** JSON-serializable comparison input: every value below crosses JSON.stringify. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const compare = (label: string, actual: JsonValue | undefined, expected: JsonValue | undefined): void => {
  const [serialized, node] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(serialized).toBe(node) })
}

const INPUTS = ['', 'a', 'hello world', '中文字符串', ' ÿ', 'x'.repeat(100_000)]
for (const algorithm of ['sha1', 'sha256', 'sha512']) {
  for (const input of INPUTS) {
    compare(
      `${algorithm}(${input.slice(0, 12)}… len ${String(input.length)})`,
      workerCrypto.createHash(algorithm).update(input).digest('hex'),
      nodeCreateHash(algorithm).update(input).digest('hex'),
    )
  }
  // Chained updates must equal the concatenated input.
  compare(
    `${algorithm} chained update`,
    workerCrypto.createHash(algorithm).update('ab').update('cd').digest('hex'),
    nodeCreateHash(algorithm).update('abcd').digest('hex'),
  )
  compare(
    `${algorithm} base64`,
    workerCrypto.createHash(algorithm).update('abc').digest('base64'),
    nodeCreateHash(algorithm).update('abc').digest('base64'),
  )
  compare(
    `${algorithm} bytes`,
    [...workerCrypto.createHash(algorithm).update(new Uint8Array([1, 2, 3])).digest()],
    [...nodeCreateHash(algorithm).update(new Uint8Array([1, 2, 3])).digest()],
  )
}

const PATHS = [
  '/dsh/config/cordis.yml', '/a b/c', '/中文/x.md', '/a%b', '/dsh/node_modules/@scope/pkg/lib/index.js',
]
for (const path of PATHS) {
  compare(`pathToFileURL(${path})`, workerUrl.pathToFileURL(path).href, nodePathToFileURL(path).href)
  compare(
    `fileURLToPath(pathToFileURL(${path}))`,
    workerUrl.fileURLToPath(workerUrl.pathToFileURL(path)),
    nodeFileURLToPath(nodePathToFileURL(path)),
  )
}

const PAIRS: [JsonValue, JsonValue][] = [
  [1, 1], [1, '1'], [{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 1, b: undefined }],
  [[1, 2], [1, 2]], [[1, 2], [2, 1]], [null, undefined], [{ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }],
]
for (const [left, right] of PAIRS) {
  compare(
    `isDeepStrictEqual(${JSON.stringify(left)}, ${JSON.stringify(right)})`,
    workerUtil.isDeepStrictEqual(left, right),
    nodeIsDeepStrictEqual(left, right),
  )
}

const callbackStyle = (value: number, callback: (error: Error | null, result?: number) => void): void => {
  if (value < 0) callback(new Error('negative'))
  else callback(null, value * 2)
}
const workerPromised = workerUtil.promisify(callbackStyle)
const nodePromised = nodePromisify(callbackStyle)
compare('promisify success', await workerPromised(21), await nodePromised(21))
const workerError = await workerPromised(-1).then(() => undefined, error => error.message)
const nodeError = await nodePromised(-1).then(() => undefined, error => error.message)
compare('promisify rejection', workerError, nodeError)
