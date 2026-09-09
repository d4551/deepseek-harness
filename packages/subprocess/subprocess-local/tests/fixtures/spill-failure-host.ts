import { spawnSubprocess } from '../../src/spawn.ts'

const [spillDir, output] = process.argv.slice(2)
if (spillDir === undefined || (output !== 'stdout' && output !== 'stderr')) {
  throw new Error('Expected spill directory and output stream')
}

const running = spawnSubprocess({
  argv: [process.execPath, '-e', `process.${output}.write('output exceeds the memory limit'); setTimeout(() => process.exit(42), 30000)`],
  cwd: process.cwd(),
  stdio: {
    stdin: 'ignore',
    stdout: { maxBytes: 4, spill: { maxBytes: 1024 } },
    stderr: { maxBytes: 4, spill: { maxBytes: 1024 } },
  },
  graceMs: 100,
}, { spillDir })

const [result] = await Promise.allSettled([running.done])
if (result.status !== 'rejected' || !(result.reason instanceof Error)) {
  throw new Error('Expected an output collection error')
}
if (!await running.waitForExit(AbortSignal.timeout(5000))) {
  running.terminateForHostExit()
  throw new Error('Process tree survived output collection failure')
}
console.log(result.reason.message)
