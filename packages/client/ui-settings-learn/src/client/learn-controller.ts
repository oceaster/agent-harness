/**
 * Learn More controller: the section's whole state machine.
 *
 * Data flow, one direction: the controller owns a snapshot store, the apply
 * closure registers it under the inject `hooks` compartment (`useLearn`), and
 * the section renders from it and writes only through the inject callbacks.
 * No React, no ctx, no module-level instance — the class is constructed inside
 * `apply`, so plugin reloads get a fresh controller.
 *
 * FOUR STATES, and the difference between the last two is the point:
 *
 * - `loading`   a read is in flight and nothing has arrived yet;
 * - `ready`     the server answered; `agents` is the server's own list, and an
 *               EMPTY list means "this profile may open no agent" — a policy
 *               answer about a real person, not a failed read;
 * - `error`     the read failed; `failure.detail` carries the server's own
 *               sentence when the body had one, and the section offers a retry;
 * - `refused`   the deployment refused the profile before the learn route ran
 *               (Guest answers 403). Retrying cannot change it, so the section
 *               states it and offers no retry.
 *
 * A read is only started by the section's first render or by its retry control,
 * so a person who never opens the tab costs no request.
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  LearnAgent, LearnApi, LearnFailure, LearnPerson,
} from './learn-api.ts'

/** Whole-section load state. */
export type LearnStatus = 'loading' | 'ready' | 'error' | 'refused'

/** The section's snapshot. */
export interface LearnState {
  /** Which of the four states the section is in. */
  status: LearnStatus
  /** The signed-in person the server resolved; null until a successful read. */
  person: LearnPerson | null
  /** One guide per agent, in the server's order — never merged, hidden, or invented. */
  agents: readonly LearnAgent[]
  /** The last failed read, with the server's own sentence when it carried one. */
  failure: LearnFailure | null
}

/** Initial snapshot: nothing read yet. */
const INITIAL: LearnState = {
  status: 'loading',
  person: null,
  agents: [],
  failure: null,
}

/** Controller dependencies. */
export interface LearnControllerOptions {
  /** The learn wire client. */
  api: LearnApi
}

/** Owns the guides snapshot and every read transition. */
export class LearnController {
  /** The snapshot the section subscribes to (`useLearn`). */
  readonly store: SnapshotStore<LearnState> = createSnapshotStore(INITIAL)

  private readonly api: LearnApi
  private reading = false

  /**
   * @param options - the learn wire client.
   */
  constructor(options: LearnControllerOptions) {
    this.api = options.api
  }

  /**
   * Read the guides. A repeated call while one is in flight is dropped rather
   * than queued, so the first-render read and the retry control cannot stack
   * requests.
   * @returns once the snapshot reflects the server (or its failure).
   */
  async load(): Promise<void> {
    if (this.reading) return
    this.reading = true
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', failure: null })
    const outcome = await this.api.read()
    this.reading = false
    if (outcome.ok) {
      this.store.set({
        status: 'ready',
        person: outcome.value.person,
        agents: outcome.value.agents,
        failure: null,
      })
      return
    }
    // A 403 is the e-server profile middleware refusing the profile BEFORE any
    // learn route exists (the guest profile does). Retrying cannot change it,
    // and it is a different fact from a roster that resolves to no agent — so
    // it is its own state, with the server's sentence attached.
    //
    // Either way the previous agents are dropped: a stale guide beside a failed
    // read would claim the failure belongs to the old content.
    this.store.set({
      status: outcome.code === 'forbidden' ? 'refused' : 'error',
      person: null,
      agents: [],
      failure: outcome,
    })
  }
}
