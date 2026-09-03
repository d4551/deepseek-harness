/**
 * The shell tools' shared model-facing result text: the output body, the
 * truncation, sandbox, and exit-status markers the `bash` and `pwsh` tools
 * emit, and the inverse parse both presenters round-trip
 * through. Every case is pinned once, at the seam that owns the text.
 */

import { describe, expect, it } from 'vitest'
import type { ShellProcessRead, ShellRunResult } from '../src/types.ts'
import { parseExitStatus, renderShellProcessRead, renderShellResult } from '../src/render.ts'

describe('parseExitStatus', () => {
  it('recovers a clean exit 0 with the body verbatim when no marker is present', () => {
    expect(parseExitStatus('hi\n\n')).toEqual({ body: 'hi\n\n', exitCode: 0 })
    expect(parseExitStatus('')).toEqual({ body: '', exitCode: 0 })
  })

  it('recovers a non-zero exit and strips only its marker from the body', () => {
    expect(parseExitStatus('oops\n[exit code: 3]')).toEqual({ body: 'oops', exitCode: 3 })
    // The marker needs the leading newline and the end of the string, so a
    // clean result whose output merely ENDS in marker-like text is not read
    // as a failure and the text stays in the body.
    expect(parseExitStatus('[exit code: 5]')).toEqual({ body: '[exit code: 5]', exitCode: 0 })
  })

  it('recovers a signal kill ahead of any non-zero exit marker', () => {
    expect(parseExitStatus('gone\n[killed by signal: SIGKILL]')).toEqual({ body: 'gone', signal: 'SIGKILL' })
    // A fake signal marker with no leading newline is output, not a kill.
    expect(parseExitStatus('[killed by signal: SIGKILL]')).toEqual({ body: '[killed by signal: SIGKILL]', exitCode: 0 })
  })

  it('keeps markers no pill shows (timeout) in the body', () => {
    expect(parseExitStatus('slow\n[timed out after 100ms]\n[exit code: 143]'))
      .toEqual({ body: 'slow\n[timed out after 100ms]', exitCode: 143 })
  })
})

describe('renderShellResult', () => {
  const base = {
    exitCode: 0 as number | null,
    signal: null as NodeJS.Signals | null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  }

  it('renders stderr-only output without a stdout prefix', () => {
    expect(renderShellResult({ ...base, stderr: { text: 'err\n', truncated: false } }))
      .toBe('[stderr]\nerr\n')
  })

  it('adds a separator when stdout does not end with a newline', () => {
    expect(renderShellResult({
      ...base,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'err', truncated: false },
    })).toBe('out\n[stderr]\nerr')
  })

  it('appends exit-code markers after a newline for unterminated output', () => {
    expect(renderShellResult({ ...base, exitCode: 7, stdout: { text: 'x', truncated: false } }))
      .toBe('x\n[exit code: 7]')
  })

  it('renders signal kills without the timeout marker when not timed out', () => {
    expect(renderShellResult({ ...base, exitCode: null, signal: 'SIGKILL' }))
      .toBe('(no output)\n[killed by signal: SIGKILL]')
  })

  it('reports a timeout that exited 0 (trapped signal) without a kill marker', () => {
    expect(renderShellResult({ ...base, exitCode: 0, signal: null, timedOut: true }))
      .toBe('(no output)\n[timed out after 1000ms]')
  })

  it('orders the timeout marker before a kill marker', () => {
    expect(renderShellResult({ ...base, exitCode: null, signal: 'SIGTERM', timedOut: true }))
      .toBe('(no output)\n[timed out after 1000ms]\n[killed by signal: SIGTERM]')
  })

  it('notes truncation with a fallback when the spill path is missing', () => {
    expect(renderShellResult({ ...base, stdout: { text: 'tail', truncated: true } }))
      .toBe('tail\n[output truncated; full output: (unavailable)]')
  })

  it('reports a denial marker before the exit marker', () => {
    expect(renderShellResult({
      ...base,
      exitCode: 2,
      stdout: { text: 'out\n', truncated: false },
      sandbox: { mode: 'read-only', denied: true },
    })).toBe('out\n[sandbox: file access denied under read-only mode]\n[exit code: 2]')
  })

  it('reports sandbox denials before exit status and hints only when escalation is advertised', () => {
    const result: ShellRunResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: '', truncated: false },
      stderr: { text: 'denied', truncated: false },
      sandbox: { mode: 'read-only', denied: true },
    }
    expect(renderShellResult(result)).toMatch(/denied under read-only mode\]\n\[exit code: 1\]$/)
    expect(renderShellResult({ ...result, exitCode: 0, stderr: { text: '', truncated: false }, stdout: { text: 'out\n', truncated: false } }, ['workspace-write'])).toBe(
      'out\n[sandbox: file access denied under read-only mode]\n'
      + '[sandbox: escalation available — retry this exact command once with sandbox_permissions '
      + '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
    )
    expect(renderShellResult({ ...result, sandbox: { mode: 'read-only', denied: false } }, ['workspace-write']))
      .not.toContain('[sandbox:')
  })
})

describe('renderShellProcessRead', () => {
  const base: ShellProcessRead = { delta: 'out\n', lossy: false }

  it('returns the delta verbatim for a lossless read', () => {
    expect(renderShellProcessRead(base)).toBe('out\n')
    expect(renderShellProcessRead({ delta: '', lossy: false })).toBe('')
  })

  it('appends the loss notice with the available spill paths', () => {
    expect(renderShellProcessRead({ ...base, lossy: true, stdoutSpillPath: '/spill/out.log' }))
      .toBe('out\n[some output was dropped from memory; full output: /spill/out.log]')
    expect(renderShellProcessRead({ ...base, lossy: true, stdoutSpillPath: '/spill/out.log', stderrSpillPath: '/spill/err.log' }))
      .toBe('out\n[some output was dropped from memory; full output: /spill/out.log, /spill/err.log]')
    // A Windows spill path is carried verbatim: the notice never rewrites it.
    expect(renderShellProcessRead({
      ...base,
      lossy: true,
      stdoutSpillPath: 'C:\\spill\\out.log',
      stderrSpillPath: 'C:\\spill\\err.log',
    }))
      .toBe('out\n[some output was dropped from memory; full output: C:\\spill\\out.log, C:\\spill\\err.log]')
  })

  it('reports (unavailable) when a lossy read has no safe spill path', () => {
    expect(renderShellProcessRead({ ...base, lossy: true }))
      .toBe('out\n[some output was dropped from memory; full output: (unavailable)]')
  })

  it('an empty lossy delta is the notice alone', () => {
    expect(renderShellProcessRead({ delta: '', lossy: true, stderrSpillPath: '/spill/err.log' }))
      .toBe('[some output was dropped from memory; full output: /spill/err.log]')
  })

  it('inserts the separating newline only when the delta lacks one', () => {
    expect(renderShellProcessRead({ delta: 'tail', lossy: true }))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
    expect(renderShellProcessRead({ delta: 'tail\n', lossy: true }))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
  })

  it('appends the runner-failed notice (denial outranked)', () => {
    expect(renderShellProcessRead({ delta: 'x', lossy: false }, { mode: 'read-only', denied: true, runnerFailed: true }))
      .toBe('x\n[sandbox: the sandbox runner itself failed under read-only mode — the command did not run; this is a sandbox problem, not a command failure]')
    const runner = renderShellProcessRead(
      { delta: '', lossy: false },
      { mode: 'workspace-write', denied: true, runnerFailed: true },
      ['danger-full-access'],
    )
    expect(runner).toContain('sandbox runner itself failed under workspace-write mode')
    expect(runner).not.toContain('file access denied')
  })

  it('appends the denial marker and hints only when escalation is advertised', () => {
    expect(renderShellProcessRead({ delta: 'tail', lossy: false }, { mode: 'read-only', denied: true }))
      .toBe('tail\n[sandbox: file access denied under read-only mode]')
    expect(renderShellProcessRead({ delta: 'x', lossy: false }, { mode: 'read-only', denied: true }, ['workspace-write']))
      .toBe('x\n[sandbox: file access denied under read-only mode]\n'
        + '[sandbox: escalation available — retry this exact command once with sandbox_permissions '
        + '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
  })
})
