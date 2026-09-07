/**
 * Standing mounts: one composition per preset, keyed on the composition
 * file's stamp, joined by every agent that names the preset, and reclaimed
 * once a generation is superseded and its last joined agent has left.
 *
 * The subtree is not inert — `dsh-skill-filesystem` watches its roots, and
 * every plugin instance in it holds its own state — so a generation that no
 * session runs on anymore must not stay mounted until the process ends.
 * @module @deepseek-ai/dsh-agent-presets/standing
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { mountPreset } from './mount.ts'
import { PresetMountError, type AgentPreset } from './preset.ts'

/** The composition file identity one standing generation was mounted from. */
export interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

/** One preset's standing composition. */
export interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary: whole-tree teardown, or reclamation once superseded and idle. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
  /** Scope keys of the agents running on this generation. */
  readonly agents: Set<ScopeKey>
  /** Set once a later generation, a copy, or a removal replaced this one as the preset's current mount. */
  superseded: boolean
  /** The one reclamation in flight or done, so racing owners await the same teardown. */
  reclaiming: Promise<void> | undefined
}

/**
 * Read one composition file's stamp. Deleted, replaced by an unreadable entry,
 * or otherwise unstattable all mean the same to the caller: the file offers no
 * identity to compare.
 * @param path - absolute path of the composition file.
 * @returns the stamp, or `undefined` when the file cannot be statted.
 */
export function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  return stat(path).then(
    ({ mtimeMs, size }) => ({ mtimeMs, size }),
    () => undefined,
  )
}

/**
 * Whether two stamps name the same file state.
 * @param a - one stamp.
 * @param b - the other stamp.
 * @returns true when mtime and size both match.
 */
export function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** What the coordinator needs from the service that owns it. */
export interface StandingMountsOptions {
  /**
   * The service's own untraced context, which standing scopes hang off.
   * Methods invoked through the traceable proxy see `this.ctx` rebound to the
   * CALLER's context, which carries a shadow; a subtree minted from it
   * resolves every service through that shadow's fiber instead of each entry's
   * own inject store, so preset rows would fail on the very services they
   * declare (the `jobs-local` selfCtx precedent).
   */
  readonly ctx: Context
  /** Report a reclamation that failed; the generation stays mounted. */
  readonly warn: (message: string) => void
}

/**
 * Standing mounts by preset id, single-flight so two agents racing the first
 * use of one preset share one composition. A settled failure is removed so a
 * later session retries a preset whose file has been fixed; a settled success
 * serves until the composition FILE visibly changes — each generation records
 * its file stamp, and a stale stamp starts the next generation for sessions
 * created afterwards. Sessions already joined keep the generation they run
 * on; a superseded generation is reclaimed as soon as no agent runs on it:
 * at once when none ever joined, otherwise when the last joined agent's scope
 * is disposed.
 */
export class StandingMounts {
  /** The current generation per preset id, as the promise its first caller started. */
  readonly pending = new Map<string, Promise<StandingMount>>()
  /** The generation each joined agent's scope key runs on. */
  private readonly joined = new WeakMap<ScopeKey, StandingMount>()

  constructor(private readonly options: StandingMountsOptions) {}

  /**
   * Resolve (or create, single-flight) the standing mount of one preset.
   *
   * Files are the only composition editor (authoring is copy/delete), so the
   * stamp is what notices an edit: a changed file starts the next generation
   * here, for this and later sessions, and retires the one it replaces. An
   * unreadable stamp serves the current generation — a mount must survive its
   * file disappearing, and failing the session over a stat would not.
   * @param preset - the resolved, mountable preset.
   * @returns the preset's current generation.
   * @throws when the composition cannot be stamped or mounted.
   */
  async ensure(preset: AgentPreset): Promise<StandingMount> {
    const pending = this.pending.get(preset.id)
    if (pending !== undefined) {
      const mounted = await pending
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      this.retire(preset.id, pending)
      return this.ensure(preset)
    }
    const created = this.mountGeneration(preset)
    this.pending.set(preset.id, created)
    return created
  }

  /**
   * Drop the standing pointer for `id` while it still is `pending` — a caller
   * that raced this one may have already started the next generation, and
   * dropping THAT pointer would fork a third — and reclaim the retired
   * generation once no agent runs on it. A copy or a removal retires whatever
   * generation is settled, so a new preset under the same id never inherits a
   * stale one; every session already joined keeps the generation it runs on.
   * @param id - the preset id whose current generation retires.
   * @param pending - the generation to retire; defaults to the current pointer.
   */
  retire(id: string, pending = this.pending.get(id)): void {
    if (pending === undefined) return
    if (this.pending.get(id) === pending) this.pending.delete(id)
    pending.then(
      (mounted) => {
        mounted.superseded = true
        this.reclaimIfIdle(mounted)
      },
      () => undefined,
    )
  }

  /**
   * Record that one agent runs on `mount`, leaving the generation it ran on
   * before. The first join of a scope key registers the leave with the
   * agent's own fiber, so a disposed agent — or a setup rolled back before
   * publication — releases its generation without any lifecycle listener.
   * @param agentCtx - the agent's scope context, whose fiber owns the leave.
   * @param agentKey - the agent's scope key, already read from `agentCtx`.
   * @param mount - the generation the agent now runs on.
   */
  join(agentCtx: Context, agentKey: ScopeKey, mount: StandingMount): void {
    const previous = this.joined.get(agentKey)
    if (previous === mount) return
    if (previous === undefined) {
      agentCtx.effect(() => () => { this.leave(agentKey) }, 'agentPresets.join()')
    } else {
      previous.agents.delete(agentKey)
    }
    mount.agents.add(agentKey)
    this.joined.set(agentKey, mount)
    if (previous !== undefined) this.reclaimIfIdle(previous)
  }

  /**
   * Release one agent's scope key from its generation, reclaiming the
   * generation when it is superseded and now idle.
   * @param agentKey - the agent's scope key.
   */
  leave(agentKey: ScopeKey): void {
    const mount = this.joined.get(agentKey)
    if (mount === undefined) return
    this.joined.delete(agentKey)
    mount.agents.delete(agentKey)
    this.reclaimIfIdle(mount)
  }

  /**
   * The generation an agent runs on, when this coordinator joined it. A
   * parent joined by an earlier roster instance resolves to `undefined`, and
   * its child then runs untracked on that inherited generation.
   * @param agentCtx - the agent's scope context.
   * @returns the joined generation, or `undefined`.
   */
  generationOf(agentCtx: Context): StandingMount | undefined {
    const agentKey = scopeOf(agentCtx)
    return agentKey === undefined ? undefined : this.joined.get(agentKey)
  }

  /**
   * Mount one generation. The scope is minted before the file is read, and
   * the stamp is taken before the mount: an edit racing the mount makes the
   * stamp stale rather than silently current, so the next session refreshes
   * instead of trusting a composition older than its stamp. A failed
   * generation removes its pointer, so a later session retries the preset.
   */
  private async mountGeneration(preset: AgentPreset): Promise<StandingMount> {
    const key: ScopeKey = { agentPreset: preset.id }
    const scope = createScope(this.options.ctx, key)
    const stamp = await compositionStamp(preset.path)
    if (stamp === undefined) {
      this.pending.delete(preset.id)
      await scope.dispose()
      throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
    }
    const [mounted] = await Promise.allSettled([mountPreset(scope.ctx, preset)])
    if (mounted.status === 'rejected') {
      this.pending.delete(preset.id)
      await scope.dispose()
      throw mounted.reason
    }
    return { key, scope, stamp, agents: new Set<ScopeKey>(), superseded: false, reclaiming: undefined }
  }

  /** Dispose a superseded generation no agent runs on; racing owners share the one teardown. */
  private reclaimIfIdle(mount: StandingMount): void {
    if (!mount.superseded || mount.agents.size > 0 || mount.reclaiming !== undefined) return
    mount.reclaiming = (async (): Promise<void> => {
      const [disposed] = await Promise.allSettled([mount.scope.dispose()])
      if (disposed.status === 'rejected') {
        this.options.warn(`agent-presets: reclaiming a superseded standing mount failed: ${String(disposed.reason)}`)
      }
    })()
  }
}
