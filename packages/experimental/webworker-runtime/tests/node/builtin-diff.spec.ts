/**
 * Differential check of the worker's implemented Buffer byte operations
 * against Node. Complements the crypto/url/util diff suite that lives beside it.
 */
import { expect, test } from 'vitest'
import * as nodeBuffer from 'node:buffer'
import * as workerBuffer from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/buffer.ts'

const { Buffer: WorkerBuffer } = workerBuffer
const { Buffer: NodeBuffer } = nodeBuffer

test('Buffer.from(string) default utf8 matches Node', () => {
  for (const input of ['', 'a', 'hello world', '中文字符串', ' ÿ', 'x'.repeat(10_000)]) {
    expect([...WorkerBuffer.from(input)]).toEqual([...NodeBuffer.from(input)])
  }
})

test('Buffer.from(string, encoding) matches Node', () => {
  const hex = 'e4b8ade69687'
  const b64 = '5Lit5paH'
  for (const [input, encoding] of [['', 'hex'], [hex, 'hex'], [b64, 'base64'], ['00112233445566778899aabbccddeeff', 'hex'], ['aGVsbG8gd29ybGQ=', 'base64']] as const) {
    expect([...WorkerBuffer.from(input, encoding)]).toEqual([...NodeBuffer.from(input, encoding)])
  }
})

test('Buffer.byteLength matches Node across encodings and inputs', () => {
  const inputs = ['', 'a', 'hello world', '中文字符串', 'x'.repeat(10_000)]
  const encodings = ['utf8', 'base64', 'hex', 'latin1'] as const
  for (const input of inputs) {
    for (const encoding of encodings) {
      expect(WorkerBuffer.byteLength(input, encoding)).toBe(NodeBuffer.byteLength(input, encoding))
    }
  }
})

test('Buffer.concat matches Node', () => {
  const parts = [WorkerBuffer.from('ab'), WorkerBuffer.from('中文'), WorkerBuffer.alloc(0)]
  const nodeParts = [NodeBuffer.from('ab'), NodeBuffer.from('中文'), NodeBuffer.alloc(0)]
  expect([...WorkerBuffer.concat(parts)]).toEqual([...NodeBuffer.concat(nodeParts)])
  expect([...WorkerBuffer.concat(parts, 3)]).toEqual([...NodeBuffer.concat(nodeParts, 3)])
})

test('Buffer toString round-trips match Node', () => {
  const payload = '中文 + ascii mix 123'
  for (const encoding of ['utf8', 'base64', 'hex', 'latin1'] as const) {
    expect(WorkerBuffer.from(payload).toString(encoding)).toBe(NodeBuffer.from(payload).toString(encoding))
  }
})

test('Buffer equals and compare match Node', () => {
  const left = WorkerBuffer.from('abc')
  const right = WorkerBuffer.from('abd')
  expect(left.equals(WorkerBuffer.from('abc'))).toBe(NodeBuffer.from('abc').equals(NodeBuffer.from('abc')))
  expect(left.equals(right)).toBe(NodeBuffer.from('abc').equals(NodeBuffer.from('abd')))
  expect(left.compare(right)).toBe(NodeBuffer.from('abc').compare(NodeBuffer.from('abd')))
})
