/**
 * Editorial grouping for the pinned Cordis core API pages.
 */

/** One declaration group rendered on a Cordis core API page. */
type CordisCoreApiSection =
  | { kind: 'class'; file: string; symbol: string; prefix?: string; heading?: string }
  | { kind: 'context-merge'; file: string; heading?: string }
  | { kind: 'decl'; file: string; symbol: string }

/** One generated Cordis core API page. */
export interface CordisCoreApiPage {
  out: string
  title: string
  intro: string
  sections: CordisCoreApiSection[]
}

/** Explicit editorial grouping for the pinned Cordis core API. */
export const CORDIS_CORE_API_PAGES: CordisCoreApiPage[] = [
  {
    out: 'docs/cordis-api/context.md',
    title: 'Context',
    intro: 'The context is the core Cordis object: every service, event, and lifecycle API is reached through `ctx`. Event methods are documented on [Events](events.md), effects and the current fiber on [Fiber](fiber.md), and plugin loading on [Registry](registry.md).',
    sections: [
      { kind: 'class', file: 'vendor/cordis/src/context.ts', symbol: 'Context', prefix: 'ctx.' },
      { kind: 'context-merge', file: 'vendor/cordis/src/reflect.ts', heading: 'Service store and mixins' },
    ],
  },
  {
    out: 'docs/cordis-api/events.md',
    title: 'Events',
    intro: 'The event-dispatch API mixed into every context. Harness event declarations and their dispatch modes are generated into each owning [subsystem page](../subsystems/core.md).',
    sections: [
      { kind: 'context-merge', file: 'vendor/cordis/src/events.ts' },
      { kind: 'decl', file: 'vendor/cordis/src/events.ts', symbol: 'EventOptions' },
      { kind: 'decl', file: 'vendor/cordis/src/events.ts', symbol: 'DispatchMode' },
    ],
  },
  {
    out: 'docs/cordis-api/fiber.md',
    title: 'Fiber',
    intro: 'A fiber is one loaded plugin instance: its lifecycle state, validated config, and registered effects. `ctx.fiber` is the current fiber, and `ctx.effect()` delegates to it.',
    sections: [
      { kind: 'context-merge', file: 'vendor/cordis/src/fiber.ts' },
      { kind: 'class', file: 'vendor/cordis/src/fiber.ts', symbol: 'Fiber', heading: 'The Fiber class' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'Effect' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'Disposable' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'EffectMeta' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'CordisError' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'ValidationError' },
    ],
  },
  {
    out: 'docs/cordis-api/registry.md',
    title: 'Registry',
    intro: 'Plugin loading and dependency injection.',
    sections: [
      { kind: 'context-merge', file: 'vendor/cordis/src/registry.ts' },
      { kind: 'decl', file: 'vendor/cordis/src/registry.ts', symbol: 'Plugin' },
      { kind: 'decl', file: 'vendor/cordis/src/registry.ts', symbol: 'Inject' },
    ],
  },
  {
    out: 'docs/cordis-api/service.md',
    title: 'Service',
    intro: 'The base class for context services. A subclass loaded as a plugin registers itself as `ctx.<name>`.',
    sections: [
      { kind: 'class', file: 'vendor/cordis/src/service.ts', symbol: 'Service' },
    ],
  },
]
