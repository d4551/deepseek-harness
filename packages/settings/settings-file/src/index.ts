/**
 * File-backed settings provider. One YAML or JSON document under the user's
 * harness home carries every namespace section; external edits hot-publish
 * through the seam, and every write re-reads the document under a
 * cross-process writer lock before patching it as a comment-preserving
 * leaf-level diff.
 * @module @deepseek-ai/dsh-settings-file
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { Document, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DocumentQueue, DocumentQueueConfigFields, readDocumentText, resolveDocumentSpec, type DocumentSpec } from '@deepseek-ai/dsh-document-queue'
import { SettingsProvider, deepEqualJson, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Settings document path; defaults to `settings.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Document format derived from the configured file extension. */
type SettingsFormat = 'yaml' | 'json'

const FORMATS: Record<string, SettingsFormat> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
}

/** Fully resolved provider parameters: the shared document location plus this document's format. */
interface ResolvedSpec extends DocumentSpec {
  format: SettingsFormat
}

/**
 * Resolve the runtime spec from plugin config: the shared location and watch
 * behavior, plus the format the file extension names.
 * @param config - raw plugin config.
 * @returns the resolved file location, format, and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const spec = resolveDocumentSpec(config, 'settings.yaml')
  const format = FORMATS[extname(spec.filename)]
  if (format === undefined) {
    throw new Error(`settings-file: extension "${extname(spec.filename)}" is not supported (use .yaml, .yml, or .json)`)
  }
  return { ...spec, format }
}

/** Whether a parsed YAML value is a map for diffing purposes. */
function isMapLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Apply the difference between one node's stored and next value as minimal
 * `setIn`/`deleteIn` edits, recursing through maps, so every untouched node —
 * and the key node of every changed pair — keeps its comments, anchors, and
 * formatting. Non-map values (arrays and scalars) replace wholesale when
 * unequal, taking any comments inside them along.
 */
function patchNode(document: Document, path: readonly string[], current: unknown, next: unknown): void {
  if (isMapLike(current) && isMapLike(next)) {
    for (const key of Object.keys(current)) {
      if (!(key in next)) document.deleteIn([...path, key])
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value)
    }
    return
  }
  if (!deepEqualJson(current, next)) document.setIn([...path], next)
}

/** Whether an exclusive file create found an existing document. */
function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/** File-backed settings provider (`settings.yaml`/`.json`). */
export class FileSettingsProvider extends SettingsProvider {
  static Config: z<Config> = z.object(DocumentQueueConfigFields)

  private readonly spec: ResolvedSpec
  /**
   * Raw text of the last successfully parsed or persisted document;
   * `undefined` while the file is absent. Watcher events whose content equals
   * this cache are no-ops, which is also the self-write suppression.
   */
  private text: string | undefined
  /**
   * The document's exclusive operation chain: watcher reloads and document
   * writes run one at a time in queue order, so a write can never render from
   * text a concurrent reload is busy replacing, and a reload can never read a
   * half-committed write.
   */
  private readonly queue: DocumentQueue

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
    this.queue = new DocumentQueue({
      label: 'settings-file',
      filename: this.spec.filename,
      debounceMs: this.spec.debounceMs,
      logger: ctx.logger,
      reconcile: () => this.reconcileFromDisk(),
    })
  }

  /** The local document is always writable through {@link SettingsProvider.update}. */
  get writable(): boolean {
    return true
  }

  /** The resolved YAML/JSON document path exposed to local configuration surfaces. */
  override get documentPath(): string {
    return this.spec.filename
  }

  /** Materialize an absent owner-only document, then return its resolved path. */
  override prepareDocument(): Promise<string> {
    return this.queue.enqueue(async () => {
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        try {
          await writeFile(this.spec.filename, '', { flag: 'wx', mode: 0o600 })
        } catch (error) {
          if (isEEXIST(error)) return
          throw error
        }
        this.text = ''
        if (!this.queue.isClosed()) this.publish({})
      })
      return this.spec.filename
    })
  }

  protected async load(): Promise<Record<string, unknown>> {
    const text = await readDocumentText(this.spec.filename)
    if (text === undefined) {
      this.text = undefined
      return {}
    }
    const doc = this.parse(text)
    this.text = text
    return doc
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // One document backs every namespace, so writes from different namespace
    // queues serialize with each other and with watcher reloads on the one
    // operation chain: each render must see the text the previous operation
    // committed, or a sibling section silently vanishes from disk.
    return this.queue.enqueue(() => this.persistSection(ns, section))
  }

  private async persistSection(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // The writer lock's exclusive create needs the parent to exist before
    // writeFileAtomic gets its own chance to create it.
    // 0700: the harness home holds user-private documents.
    await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.spec.filename, async () => {
      // Read-modify-write: fold in any on-disk state this process has not
      // observed yet — an external edit still inside the watcher debounce
      // window, a change the watcher missed, or another process's write — so
      // the render below can never resurrect a stale document. An unparsable
      // on-disk document fails the write loud instead of silently overwriting
      // a user's manual edit.
      await this.reconcileFromDisk()
      const output = this.spec.format === 'yaml'
        ? this.renderYaml(ns, section)
        : this.renderJson(ns, section)
      // 0600: a document that may hold personal values is never world-readable.
      await writeFileAtomic(this.spec.filename, output, { mode: 0o600, dirMode: 0o700 })
      this.text = output
    })
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // The base init loads and publishes; a parse failure there is a boot
    // failure: an existing-but-invalid document must fail loud, never be
    // silently ignored or overwritten.
    yield* super[Service.init]()
    if (this.spec.watch) await this.queue.watch()
    // Quiesce every operation chain, even when no watcher is configured.
    yield () => this.queue.close()
  }

  /** Parse one document text into raw sections, failing on a non-map root. */
  private parse(text: string): Record<string, unknown> {
    let root: unknown
    if (this.spec.format === 'yaml') {
      // `prettyErrors` is on only for `linePos`; `error.message` is never
      // used, because the parser quotes the offending source line and a
      // settings document can hold a `role('secret')` value.
      const document = parseDocument(text, { prettyErrors: true })
      if (document.errors.length > 0) {
        throw new Error(`settings-file: invalid document at ${this.spec.filename}: ${
          document.errors.map((error) => {
            const at = error.linePos?.[0]
            /* v8 ignore next -- `prettyErrors` populates linePos on every error; the guard answers its optional type */
            return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
          }).join('; ')}`)
      }
      root = document.toJS() ?? {}
    } else {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
      throw new TypeError(`settings-file: ${this.spec.filename} must be a map of namespace sections`)
    }
    return root as Record<string, unknown>
  }

  /**
   * Compare the on-disk text against the cache and publish any difference
   * into the seam. Absence publishes the empty document; an unreadable or
   * unparsable file throws, so each caller picks its policy — a reload warns
   * and keeps the last good document, a write fails loud.
   */
  private async reconcileFromDisk(): Promise<void> {
    const text = await readDocumentText(this.spec.filename)
    if (text === this.text || this.queue.isClosed()) return
    if (text === undefined) {
      this.text = undefined
      this.publish({})
      return
    }
    const doc = this.parse(text)
    this.text = text
    this.publish(doc)
  }

  /**
   * Render the next YAML text by patching one namespace in the
   * comment-preserving document. The next section lands as a leaf-level diff
   * against the stored one — only changed values set, only removed keys
   * delete — so comments inside the section survive edits to their siblings,
   * not just comments outside it.
   */
  private renderYaml(ns: SettingsNamespace, section: Record<string, unknown>): string {
    if (this.text === undefined) {
      return new Document({ [ns]: section }).toString()
    }
    // this.text only ever caches content that parsed successfully, so this
    // re-parse (for the mutable comment-preserving tree) cannot fail, and
    // parse() already rejected any non-map root.
    const document = parseDocument(this.text)
    const root: unknown = document.toJS()
    patchNode(document, [ns], isMapLike(root) ? root[ns] : undefined, section)
    return document.toString()
  }

  /** Render the next JSON text by replacing one namespace key. */
  private renderJson(ns: SettingsNamespace, section: Record<string, unknown>): string {
    const root = this.text === undefined
      ? {}
      : this.parse(this.text)
    root[ns] = section
    return `${JSON.stringify(root, null, 2)}\n`
  }
}

export default FileSettingsProvider
