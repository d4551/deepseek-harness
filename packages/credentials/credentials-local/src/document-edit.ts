import { Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { Alias, Node, Pair, YAMLMap } from 'yaml'
import { isDeepStrictEqual } from 'node:util'

/** Find entries by their resolved YAML key, including keys written as aliases. */
function entries(document: Document, map: YAMLMap, key: string): Pair[] {
  return map.items.filter((pair) => {
    const value: unknown = isNode(pair.key) ? pair.key.toJS(document) : pair.key
    if (typeof value === 'string') return value === key
    return (typeof value === 'boolean' || typeof value === 'number') && String(value) === key
  })
}

/** Retain an alias's annotations on an independently owned value. */
function independentAlias(document: Document, alias: Alias): Node {
  const original: unknown = alias.toJS(document)
  const replacement = document.createNode(original, { aliasDuplicateObjects: false })
  replacement.comment = alias.comment ?? null
  replacement.commentBefore = alias.commentBefore ?? null
  replacement.spaceBefore = alias.spaceBefore ?? false
  return replacement
}

/** Entries removed together after all original anchor dependencies are resolved. */
interface EntryRemoval {
  map: YAMLMap
  matching: Pair[]
}

/** Remove an address from every merge contributor so an older value cannot reappear. */
function planEntryRemoval(
  document: Document,
  node: unknown,
  key: string,
  changed: Set<Node>,
  replacements: Map<Alias, Node>,
  removals: EntryRemoval[],
): void {
  if (isAlias(node)) {
    const independent = independentAlias(document, node)
    replacements.set(node, independent)
    planEntryRemoval(document, independent, key, changed, replacements, removals)
  } else if (isSeq(node)) {
    changed.add(node)
    for (const source of node.items) planEntryRemoval(document, source, key, changed, replacements, removals)
  } else if (isMap(node)) {
    changed.add(node)
    const matching = entries(document, node, key)
    for (const pair of matching) {
      for (const child of [pair.key, pair.value]) {
        if (isNode(child)) visit(child, { Node: (_, descendant) => { changed.add(descendant) } })
      }
    }
    removals.push({ map: node, matching })
    for (const pair of node.items) {
      if (isNode(pair.key) && pair.key.addToJSMap !== undefined) {
        planEntryRemoval(document, pair.value, key, changed, replacements, removals)
      }
    }
  } else {
    throw new TypeError('credentials-local: validated merge source must be a mapping')
  }
}

/**
 * Edit one credential address without changing values that share YAML anchors.
 * Aliases whose sources change or disappear become independent values before
 * the edit; all resolutions use the original tree and its anchor ordering.
 * @param text - the admitted document text, absent before the first write.
 * @param section - the credential address space to edit.
 * @param key - the credential's resolved key in that section.
 * @param value - the replacement value, or undefined to remove the entry.
 * @param version - the canonical version stamp for a newly created document.
 * @returns the edited document with unrelated credential values preserved.
 */
export function renderCredentialEdit(
  text: string | undefined,
  section: 'refs' | 'records',
  key: string,
  value: unknown,
  version: number,
): string {
  const document = text === undefined ? new Document({}) : parseDocument(text)
  if (document.contents === null || (isScalar(document.contents) && document.contents.value === null)) {
    const empty = document.createNode({})
    if (document.contents !== null) {
      empty.comment = document.contents.comment ?? null
      empty.commentBefore = document.contents.commentBefore ?? null
      empty.spaceBefore = document.contents.spaceBefore ?? false
    }
    document.contents = empty
  }
  const root = document.contents
  if (!isMap(root)) throw new TypeError('credentials-local: validated document must be a mapping')
  if (entries(document, root, 'version').length === 0) root.set('version', version)
  const changed = new Set<Node>()
  const detached = new Set<Alias>()
  const replacements = new Map<Alias, Node>()
  const removals: EntryRemoval[] = []
  let sectionPair = entries(document, root, section).at(-1)
  if (sectionPair === undefined) {
    const resolved: unknown = root.toJS(document)
    if (typeof resolved !== 'object' || resolved === null) {
      throw new TypeError('credentials-local: validated root must resolve to a mapping')
    }
    const inherited: unknown = new Map(Object.entries(resolved)).get(section)
    if (inherited !== undefined) {
      planEntryRemoval(document, root, section, changed, replacements, removals)
      const promoted = removals.flatMap(removal => removal.matching).find(pair =>
        isNode(pair.value) && isDeepStrictEqual(pair.value.toJS(document), inherited))
      if (promoted === undefined) throw new TypeError('credentials-local: inherited section has no matching source entry')
      for (const node of [promoted.key, promoted.value]) {
        if (isNode(node)) visit(node, { Alias: (_, alias) => { detached.add(alias) } })
      }
      root.items.push(promoted)
      sectionPair = promoted
    }
  }
  const sectionNode: unknown = sectionPair?.value
  if (value === undefined) {
    planEntryRemoval(document, sectionNode, key, changed, replacements, removals)
  } else if (isAlias(sectionNode)) detached.add(sectionNode)
  else if (isNode(sectionNode)) changed.add(sectionNode)
  if (value !== undefined && isMap(sectionNode)) {
    for (const pair of entries(document, sectionNode, key)) {
      if (isNode(pair.value)) visit(pair.value, { Node: (_, child) => { changed.add(child) } })
      if (isAlias(pair.value)) detached.add(pair.value)
    }
  }
  visit(document, {
    Alias: (_, alias) => {
      if (replacements.has(alias)) return
      const source = alias.resolve(document)
      if (!detached.has(alias) && (source === undefined || !changed.has(source))) return
      replacements.set(alias, independentAlias(document, alias))
    },
  })
  visit(document, { Alias: (_, alias) => replacements.get(alias) })

  let map: unknown = sectionPair?.value
  if (map === undefined || map === null || (isScalar(map) && map.value === null)) {
    const empty = document.createNode({})
    if (isScalar(map)) {
      empty.comment = map.comment ?? null
      empty.commentBefore = map.commentBefore ?? null
      empty.spaceBefore = map.spaceBefore ?? false
    }
    map = empty
    if (sectionPair === undefined) root.set(section, map)
    else sectionPair.value = map
  }
  if (!isMap(map)) throw new TypeError('credentials-local: validated section must be a mapping')
  for (const removal of removals) {
    // YAML attaches the first entry's leading annotation to its section map.
    const first = removal.map.items[0]
    if (first !== undefined && removal.matching.includes(first)) removal.map.commentBefore = null
    removal.map.items = removal.map.items.filter(pair => !removal.matching.includes(pair))
  }
  if (value !== undefined) {
    const target = entries(document, map, key).at(-1)
    if (target === undefined) map.set(key, document.createNode(value))
    else if (isScalar(target.value) && typeof value === 'string') target.value.value = value
    else target.value = document.createNode(value)
  }
  return document.toString()
}
