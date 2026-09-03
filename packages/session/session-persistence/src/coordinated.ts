/**
 * The `SessionPersistence` service API for backends that delegate their whole
 * write and read path to a {@link PersistenceCoordinator}. Every first-party
 * backend (JSONL, SQLite) composes the coordinator and forwards the same eight
 * operations to it verbatim, so the forwards live once beside the Service
 * Definition that declares them instead of once per provider.
 *
 * A subclass supplies the coordinator it constructed and keeps only the
 * operations that depend on its storage medium: {@link SessionPersistence.locate},
 * `list`, `listSnapshots`, and its `PersistenceBackend` storage hooks.
 *
 * @module @deepseek-ai/dsh-session-persistence/coordinated
 */

import type { Session, SessionEvent, SessionHeader, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { PersistenceCoordinator } from './coordinator.ts'
import type { BorrowedSessionSource, SessionInspection } from './index.ts'
import { SessionPersistence } from './index.ts'

/**
 * A durable backend whose service API is the coordinator's. The operation
 * contracts are the ones declared on {@link SessionPersistence}; this layer
 * adds no behavior of its own beyond the forward.
 * @typeParam TornMarker - the backend's torn-tail marker, carried through to
 * its coordinator and storage hooks.
 */
export abstract class CoordinatedSessionPersistence<TornMarker = unknown> extends SessionPersistence {
  /**
   * The orchestration every forwarded operation runs through. A subclass
   * constructs it against its own storage hooks and assigns it before the
   * service is published, so no forward can observe it unset.
   */
  protected abstract readonly coordinator: PersistenceCoordinator<TornMarker>

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  override ensureMaterialized(session: Session): Promise<void> {
    return this.coordinator.ensureMaterialized(session)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  override borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal):
  Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }
}
