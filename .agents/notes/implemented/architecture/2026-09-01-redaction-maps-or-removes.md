# Agent Note: Secret redaction maps a node or removes it

Status: implemented

English | [中文](2026-09-01-redaction-maps-or-removes.zh.md)

## Problem

`redactSecrets` strips `role('secret')` fields out of a settings value before it crosses the Host API. It walked `object`, `dict`, and `array`, and returned every other node kind verbatim from a `default` branch. Schemastery resolves seventeen kinds, so `tuple`, `union`, `intersect`, `transform`, `lazy`, and anything registered through `Schema.extend` all fell to that branch.

The result was fail-open in the position that matters. A `role('secret')` declared under any of those kinds was returned with the value, and the `secrets` sidecar recorded nothing, so neither the response nor the record showed that a secret had been missed. The `TODO(settings-wire-redaction)` marker at the branch named the gap, and the [config-plane boundaries note](2026-07-30-config-plane-boundaries.md) and [plugin-owned settings surface note](2026-08-12-plugin-owned-settings-surface.md) both carried it forward — the second observing that serving every registered namespace widens the blast radius from schemas audited here to any third-party schema.

No shipped schema leaked. This repository declares exactly one secret, `apiKey` in `dsh-web-search-deepseek`, directly under an object; `dsh-llm-pi-ai` registers a namespace with fourteen union and transform sites, but every one is an enum of consts. The defect was that nothing stopped the next one.

## Decision

**A node kind is either mapped onto the value position by position, or its subtree is removed.** There is no third answer and no branch that returns a value it did not walk.

`tuple`, `union`, and `intersect` are mapped. A tuple walks its `list` by index. A union and an intersect describe the same position as their members, so stripping folds the members in declaration order: each pass removes the secrets that member declares and carries the keys it does not describe, because the object walk already preserves keys outside its property map. Folding a union over members that do not match the value contributes their unset object slots, which over-reports a position rather than leaving one unremoved — the safe direction for a sidecar whose consumer renders write-only inputs.

`transform`, `lazy`, and `Schema.extend` kinds cannot be mapped. A transform's `inner` restates its *input* while the stored value is the transformed result; a lazy resolves its members only during validation; an extension type names relations this structural view does not model. For these the walker asks one question — does this node declare a secret anywhere beneath it — and answers it with `declaresSecret`, a probe over `inner`, `dict`, and `list` guarded by a `WeakSet` so a self-referential schema terminates. No secret beneath it means the value is provably safe and passes through. A secret beneath it means the whole subtree is removed and its root recorded.


## Alternatives considered

**Throw on an unmappable node.** The repository's fail-loud rule points here, and the earlier notes framed the answer as a `describeForWire()` that refuses a schema it cannot prove safe. Rejected at this layer: `redactSecrets` is called from `describe({ redactSecrets: true })`, which builds the list of every namespace at once, so one unprovable schema would take down the whole settings page rather than its own row. Removing the subtree fails closed at the position that is actually unprovable and leaves refusal to the wire layer that can scope it to one namespace.

**Strip every unmappable node unconditionally.** Simpler, and genuinely fail-closed, but `z.union([z.string(), z.number()])` is ordinary and secret-free; blanking every such field would delete most of the configuration surface to protect a secret that is not there. The `declaresSecret` probe buys the same guarantee for the cost of one structural scan.

**Leave the marker and document the hazard.** What the previous state did. It enforces "no secret under a union" in prose, which no gate checks.

## Consequences

- A secret declared under `tuple`, `union`, or `intersect` is now removed and recorded like any other; one declared under `transform`, `lazy`, or an extension type removes that subtree.
- The `secrets` sidecar can now name a container root rather than a leaf, which the existing "secret-role container as one opaque secret leaf" behavior already produced.
- A union may report unset secret slots contributed by members the value does not match. A form renders a write-only input for a slot the value could hold.
- `redactSecrets` keeps its signature, so `describe`, the settings controller, and the api-catalog declaration are unchanged.
- Two gaps in the same area stay open and stay recorded in the package's Known Limitations: `schema.toJSON()` carries a secret field's `.default(...)`, and a write rejection returns schema text that can quote the submitted value. Both live in the serialized envelope, not the value.

## Testing

`packages/settings/settings/tests/redact.spec.ts` covers each mapped kind against a real schemastery schema — a tuple stripped by index with a trailing member left to its own schema, a union member's secret removed, a secret-free union carried through, an intersect member's contribution stripped while its siblings survive — and each unmappable kind both ways: a transform over a secret removed whole, a transform over a plain string passed through. Structural fixtures cover a self-referential node, an extension node whose secret sits behind a secret-free sibling in `list` and in `dict`, and the member-list-absent path for `union` and `tuple`. The file holds per-file 100% statements, branches, functions, and lines.
