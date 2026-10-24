/**
 * Which interface the sidebar paints, and which conversation this app was asked
 * to open — the two facts a page load used to carry, now carried by a message.
 *
 * Owen, 2026-10-24: the harness is an IDE workspace, so moving between Delta and
 * Epsilons must not load a document. The wrapper page therefore keeps ONE frame
 * with ONE `src` and posts `dsh:open` at this window; this controller is where
 * that message lands, and it is deliberately the only owner of the answer:
 *
 *   - it starts from the URL fragment ({@link bootIntentOf}), so a cold load, a
 *     bookmark and a reload land exactly where they did before the wire existed;
 *   - it applies a message only when the message CHANGES something. Repeating an
 *     intent the app already shows is a no-op — no store write, no re-open of a
 *     conversation — because the parent is expected to be chatty (it re-posts on
 *     its own re-renders), and an idempotent receiver is what makes that safe;
 *   - it hands the conversation half to index.ts as a REQUEST rather than
 *     applying it (`takeConversation`), because opening one must wait for the
 *     roster that proves this person may open it, exactly as the fragment path
 *     always has.
 *
 * No React here and no module-level instance: index.ts constructs one inside
 * `apply`, so a plugin reload gets a fresh controller and a disposed fiber takes
 * the message listener with it.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  ROUTE_MESSAGE, READY_MESSAGE, openIntentOf,
  type BootIntent, type HarnessSurface,
} from './surface.ts'

/** What the sidebar paints: the one word the parent switches between. */
export interface SurfaceSnapshot {
  /** The interface this app is showing. */
  readonly surface: HarnessSurface
  /**
   * Whether the parent has shown it owns navigation (it accepted at least one
   * `dsh:open`). Then BOTH interfaces are resident — the other one is mounted
   * and merely not visible, so the next switch is a visibility flip and nothing
   * else, which is the whole point of the message contract.
   *
   * A page nobody drives by message keeps one interface mounted, exactly as it
   * did before the wire existed: the interface that is not this page load's is
   * absent from the DOM, and the composed checks that hold that absence (the
   * inbox paints no sub-agent markup; the epsilon surface carries no agent row
   * at all) stay true on a cold load.
   */
  readonly resident: boolean
}

/**
 * The window members this controller uses. `window` itself satisfies it; a unit
 * test passes a stand-in with the same shape, which is why the parent is typed
 * `unknown` (nothing here reads across the frame boundary).
 */
export interface MessageHost {
  /** The embedding window, or this window when the app runs on its own. */
  readonly parent: unknown
  /** `location.ancestorOrigins` (Chromium) — the parent's origin, unasked. */
  readonly location?: { readonly ancestorOrigins?: ArrayLike<string> }
  /** `document.referrer` — the parent's URL when the browser offers it. */
  readonly document?: { readonly referrer?: string }
  /** Register one `message` listener. */
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  /** Remove one `message` listener. */
  removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
}

/**
 * The parent's origin, read from the browser rather than from a message.
 *
 * Two sources, in order: `location.ancestorOrigins` (Chromium answers with the
 * ancestor origins directly) and `document.referrer` (every browser; the frame
 * `src` is same-site, so the origin survives the default referrer policy). This
 * matters because `postMessage` must be given an EXACT `targetOrigin` and this
 * app never posts with `'*'`: a reply that cannot name its recipient is a reply
 * that would be readable by any page that managed to frame the harness.
 * @param host - the window this app runs in.
 * @returns the parent's origin, or null when the browser withheld it.
 */
export function parentOriginOf(host: MessageHost): string | null {
  const ancestors = host.location?.ancestorOrigins
  const first = ancestors !== undefined && ancestors.length > 0 ? ancestors[0] : undefined
  if (typeof first === 'string' && first !== '' && first !== 'null') return first
  const referrer = host.document?.referrer
  if (referrer === undefined || referrer === '') return null
  try {
    const { origin } = new URL(referrer)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * The surface/address state machine for one mounted app.
 *
 * Read it as three questions with one answer each: WHICH surface shows
 * ({@link store}), WHAT was asked for and not yet opened ({@link takeConversation}),
 * and WHAT the person has since navigated to ({@link announce}, so the parent's
 * URL and menu can follow them).
 */
export class SurfaceController {
  /** The surface to paint; a `SnapshotStore` so React can subscribe to it. */
  readonly store: SnapshotStore<SurfaceSnapshot>

  /** The address this app is showing, message-applied or boot-read. */
  private intent: BootIntent

  /**
   * The conversation an `dsh:open` asked for that nobody has opened yet. Held
   * until the roster proves the person may open it — see index.ts.
   */
  private pending: string | null

  /** The token this app last echoed to the parent. */
  private token = ''

  /** The parent's origin, pinned from the browser, or from its first message. */
  private parentOrigin: string | null = null

  /** The window this app listens to and answers through, once attached. */
  private host: MessageHost | null = null

  /** Listeners waiting for a conversation request (index.ts's open path). */
  private readonly requests = new Set<() => void>()

  /**
   * Start from what this page load already decided.
   * @param initial - the intent {@link bootIntentOf} read from the URL fragment.
   */
  constructor(initial: BootIntent) {
    this.intent = initial
    // A fragment that names a conversation is the same request a message can
    // make, so it rides the same queue: one open path, one disarm.
    this.pending = initial.conversation
    this.store = createSnapshotStore<SurfaceSnapshot>({ surface: initial.surface, resident: false })
  }

  /** The surface the sidebar paints. */
  get surface(): HarnessSurface {
    return this.intent.surface
  }

  /** The conversation an intent asked for, retired by the caller once applied. */
  takeConversation(): string | null {
    const pending = this.pending
    this.pending = null
    return pending
  }

  /**
   * Whether an intent asked for a conversation nobody has opened yet.
   * @returns true while an open request is still outstanding.
   */
  hasConversationRequest(): boolean {
    return this.pending !== null
  }

  /**
   * Listen for conversation requests (a fragment at boot, a message later).
   * @param listener - called after every accepted request.
   * @returns unsubscribe.
   */
  onConversationRequest(listener: () => void): () => void {
    this.requests.add(listener)
    return () => { this.requests.delete(listener) }
  }

  /**
   * Apply one intent, IF it asks for something this app is not already showing.
   *
   * Idempotence is the contract's, not an optimisation: the parent may re-post
   * the address after a reload, a re-render or a retry, and the second copy must
   * cost nothing and disturb nothing.
   *
   * A conversation is only meaningful on the inbox interface — the epsilon
   * interface lists Delta's workers, and a worker has no address a fragment or a
   * message could carry — so a conversation word arriving with `epsilons` is
   * ignored rather than half-applied.
   * @param intent - the address to show (a validated `dsh:open` or the boot read).
   * @returns true when the app's state changed.
   */
  apply(intent: BootIntent): boolean {
    const surfaceChanged = intent.surface !== this.intent.surface
    const asksConversation = intent.surface === 'inbox' && intent.conversation !== null
    const conversationChanged = asksConversation && intent.conversation !== this.intent.conversation
    if (!surfaceChanged && !conversationChanged) return false
    if (surfaceChanged) {
      this.intent = { ...this.intent, surface: intent.surface }
      this.publish(intent.surface)
    }
    if (conversationChanged) {
      this.intent = { ...this.intent, conversation: intent.conversation }
      this.pending = intent.conversation
      for (const listener of this.requests) listener()
    }
    return true
  }

  /**
   * Both interfaces become resident: the parent has shown it drives this app, so
   * the interface the person is not looking at is mounted and merely hidden
   * instead of absent. Idempotent — the second message costs a store read.
   */
  private becomeResident(): void {
    const current = this.store.getSnapshot()
    if (current.resident) return
    this.store.set({ ...current, resident: true })
  }

  /**
   * Write the surface this app shows, keeping the resident flag. A no-op when it
   * already shows that interface, so a repeated intent costs no store write and
   * therefore no render.
   * @param surface - the interface to paint.
   */
  private publish(surface: HarnessSurface): void {
    const current = this.store.getSnapshot()
    if (current.surface === surface) return
    this.store.set({ ...current, surface })
  }

  /**
   * Report a navigation the PERSON made inside the app, and remember it as the
   * address being shown so that a later identical `dsh:open` is a no-op.
   * @param surface - the interface they are in.
   * @param conversation - the agent they opened, or null for a channel/worker.
   */
  announce(surface: HarnessSurface, conversation: string | null): void {
    this.intent = { surface, conversation }
    this.post({ type: ROUTE_MESSAGE, surface, conversation })
  }

  /**
   * Listen for the parent's messages and announce that this app can receive
   * them. Installed once, from the plugin's effect scope, so unloading the
   * fiber takes the listener with it.
   *
   * THE HANDSHAKE, and why it is two messages: `dsh:open` may arrive before
   * `dsh:ready` (the parent posts as soon as the frame exists) and must not be
   * lost, so the listener installs BEFORE ready is posted and applies whatever
   * arrives. `dsh:ready` is posted with the token of the last `dsh:open`
   * applied — empty on a cold boot, when no message has arrived yet — and again
   * whenever an `dsh:open` carries a token this app has not echoed, so a parent
   * that keys its handshake on its own token always completes it.
   * @param host - the window to listen on; `window` in production.
   * @returns disposer removing the listener.
   */
  attach(host: MessageHost = globalThis as unknown as MessageHost): () => void {
    // Running on its own (opened directly, no wrapper): no parent to hear and
    // nothing that may address this app, so the boot read stands alone.
    if (host.parent === host) return () => {}
    this.host = host
    this.parentOrigin = parentOriginOf(host)
    const onMessage = (event: MessageEvent): void => {
      // ONLY the embedding page may move this app. `window.parent` cannot be
      // impersonated from inside a frame, and the origin check is the second
      // half of the same sentence for browsers that report it.
      if (event.source !== host.parent) return
      if (this.parentOrigin !== null && event.origin !== this.parentOrigin) return
      const intent = openIntentOf(event.data)
      if (intent === null) return
      // The first parent message pins the origin when the browser withheld it,
      // which is what lets the reply carry an exact target.
      if (this.parentOrigin === null) this.parentOrigin = event.origin
      this.apply(intent)
      // One accepted message is the parent saying it owns navigation: from here
      // both interfaces stay mounted (see SurfaceSnapshot.resident).
      this.becomeResident()
      if (intent.token !== this.token) {
        this.token = intent.token
        this.postReady()
      }
    }
    host.addEventListener('message', onMessage)
    // A parent whose origin is unknown cannot be answered without posting to
    // '*'. Say nothing; the first `dsh:open` pins the origin and the ready
    // below is posted then.
    if (this.parentOrigin !== null) this.postReady()
    return () => {
      host.removeEventListener('message', onMessage)
      this.host = null
    }
  }

  /** Post `dsh:ready` with the token of the last intent applied. */
  private postReady(): void {
    this.post({ type: READY_MESSAGE, token: this.token })
  }

  /**
   * Post one message to the embedding window, with an exact target origin.
   * @param message - the contract message to send.
   */
  private post(message: Record<string, unknown>): void {
    const parent = this.host?.parent as { postMessage?: (data: unknown, targetOrigin: string) => void } | undefined
    const targetOrigin = this.parentOrigin
    if (parent?.postMessage === undefined || targetOrigin === null) return
    parent.postMessage(message, targetOrigin)
  }
}
