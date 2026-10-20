// Host-side Session seeding, shared by the browser lane's scaffold and the
// inbox boot helper that replaced the removed workspace picker.
//
// Seeding goes through the REAL backend API (a throwaway Context + SessionStore
// + JSONL plugin — the semantic-checkpoint precedent), never raw file writes: no
// knowledge of bucket hashing, filename encoding, or compression, and malformed
// session events fail loud at seed time.
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

/**
 * The one host fact seeding needs: the persistence root the booted tree reads.
 * Structural on purpose — the scaffold satisfies it, and so does any narrower
 * world object a scenario hands over.
 */
export interface SeedRoot {
  /** Temp persistence root the booted host lists sessions from. */
  readonly persistenceRoot: string
}

/** Seed one materialized cold Session whose log has no turn/start event. */
export async function seedBlankSession(
  root: SeedRoot,
  id: string,
  cwd: string,
): Promise<SessionId> {
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now() - 60_000,
    cwd,
    delegationDepth: 0,
  }
  await persistSeedSession(root, meta, [{
    type: 'session/end-seed',
    seq: 0,
    time: meta.createdAt,
    data: {},
  }])
  return meta.id
}

/** Materialize one detached Session fixture through the shipped JSONL provider. */
export async function persistSeedSession(
  root: SeedRoot,
  meta: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    // Same root as the booted tree with the plugin's own default compression,
    // so the host's directory-scan list() sees one consistent encoding.
    await seeder.plugin(JsonlSessionPersistence, { root: root.persistenceRoot })
    await seeder.sessionPersistence.create(meta)
    await seeder.sessionPersistence.append(meta.id, events)
  } finally {
    await seeder.fiber.dispose()
  }
}
