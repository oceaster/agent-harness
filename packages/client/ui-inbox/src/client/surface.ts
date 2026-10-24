/**
 * Which interface this page load is, and — when the address says so — WHICH
 * CONVERSATION it opens. ONE shell, TWO interfaces, one conversation door.
 *
 * THE FRAGMENT IS THE FALLBACK, NOT THE MECHANISM. Owen, 2026-10-24: "The
 * Agent-Harness should always be rendered and rendering (or at least in theory)
 * - if closed, it's actually just 'not-visible'." So the page that wraps this
 * app keeps ONE frame with ONE `src` and switches what the app shows by
 * MESSAGE ({@link OPEN_MESSAGE}), exactly as an IDE switches a pane: nothing
 * here reloads, and both surfaces stay mounted (see SurfacePanels.tsx). The
 * fragment still decides what a COLD load paints — a bookmark, a pasted link
 * and a reload land where they always have, without the wrapper having to ask
 * — which is why this reader stays the single owner of both words.
 *
 * Owen, 2026-10-23: "2 separate interfaces BUT SAME SAME, DIFFERENT, BUT SAME".
 * The shell — the sidebar column, the conversation column, the read-only worker
 * transcript, the header, the composer machine — is one thing. What the sidebar
 * LISTS is not: the Delta entry shows the person's agents and Agent Channels,
 * the Epsilon entry shows Delta's sub-agents. This module owns the one word that
 * decides which, and nothing else.
 *
 * THE MECHANISM, and why it is this one: the harness web app has no URL routing
 * for its surfaces (apps/web mounts a single shell, and no package reads
 * location). The two entry points are separate links, so the mode has to survive
 * a page load, and the smallest thing that does that is the URL FRAGMENT, read
 * once at boot. A fragment is chosen over a query string because:
 *
 *   - it never reaches the server, so no proxy, nginx location or static-file
 *     lookup has to know the word (the deployed origin serves the shell at one
 *     path and rewrites nothing);
 *   - it survives the e-server page that wraps this app in an iframe: that page
 *     only has to change the `src` it already builds;
 *   - it costs one function and one read at registration — no router, no
 *     history library, no server route, and no change to the boot kernel.
 *
 * A reload, a bookmark and a pasted link all land in the same interface, which
 * is the whole point: the two entries have to be ADDRESSABLE, not merely
 * different buttons.
 *
 * THE CONVERSATION FORM, and why it is `#c/<agent>` and not `#s/<sessionId>`:
 * the e-server top bar stopped being a link to this app's front page and became a
 * menu of exact entry points (Owen, 2026-10-23: "instead of taking you directly
 * to the agent harness application you instead always select an exact entry
 * point"), so an address has to name a CONVERSATION. Two spellings were possible
 * and only one survives being used:
 *
 *   - a conversation's session id is DERIVED per (person, agent) and REPLACED
 *     when the person clears it, so a `#s/<sessionId>` link starts wrong the day
 *     somebody starts over — and there is no session id at all for an agent
 *     whose conversation has never been created, which is exactly the state a
 *     first-ever menu row would have to be built from;
 *   - the agent id is stable, is what the row's name and portrait describe, and
 *     is the key the inbox controller already opens by: `open(agent)` POSTs
 *     `/v1/browser/inbox/open` (idempotent — the server creates the conversation
 *     if it is new and answers the same one otherwise) and then selects the
 *     session the server returned. That is the SAME door the sidebar row uses,
 *     so a deep link can never disagree with a click.
 *
 * So one reader decides both words at boot ({@link bootIntentOf}), and
 * {@link surfaceOf} stays the surface half of it, unchanged in behaviour:
 * `#epsilons` keeps meaning the epsilon interface and everything else —
 * including `#c/<agent>` — means the inbox interface.
 */

/** The two interfaces of the one shell. */
export type HarnessSurface = 'inbox' | 'epsilons'

/**
 * The fragment that opens the Epsilon interface.
 *
 * Spelled here, and nowhere else on this side: the e-server page that wraps the
 * shell appends it to the iframe `src`, so this constant is the wire between the
 * two repositories. `/ai/harness` carries no fragment (inbox) and
 * `/ai/harness/epsilons` carries this one.
 */
export const EPSILONS_FRAGMENT = '#epsilons'

/**
 * The fragment prefix that opens ONE agent's conversation.
 *
 * The other half of the same wire, and the same shape of spelling: the e-server
 * menu's every row points at `/ai/harness/c/<agent>`, whose frame `src` carries
 * `#c/<agent>`. Spelled as a prefix rather than a regex so a hand-written link
 * and this reader cannot drift apart.
 */
export const CONVERSATION_FRAGMENT = '#c/'

/** What one page load is asked to paint. */
export interface BootIntent {
  /** The interface this load mounts. */
  readonly surface: HarnessSurface
  /**
   * The agent whose conversation this load opens on boot, or null for the plain
   * front page. An agent id, never a session id — see the header for why.
   */
  readonly conversation: string | null
}

/**
 * The agent ids an address may name: the same charset the e-server side builds
 * conversation ids from (`[a-z0-9-]`), so a fragment cannot smuggle a path, a
 * quote or a query through this reader and into a request body. Anything else is
 * not a conversation this app can open, and reads as the plain front page.
 */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Which interface and which conversation a location's fragment asks for.
 *
 * THE single reader: this is the only place in the client that decides what a
 * `location.hash` means, so `#epsilons`, `#c/<agent>` and a bare URL cannot
 * disagree with each other or with the e-server links that build them.
 * @param hash - `location.hash`, with or without the leading `#`.
 * @returns the interface to mount, and the agent to open once it is mounted.
 */
export function bootIntentOf(hash: string): BootIntent {
  // A trailing slash is tolerated because a pasted link is written by hand.
  const fragment = hash.replace(/\/+$/, '')
  const bare = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (bare === EPSILONS_FRAGMENT.slice(1)) return { surface: 'epsilons', conversation: null }
  if (bare.startsWith(CONVERSATION_FRAGMENT.slice(1))) {
    const agent = bare.slice(CONVERSATION_FRAGMENT.length - 1)
    // A fragment naming an agent this app cannot address is not a half-open
    // conversation: it is the front page, exactly like a stale bookmark.
    if (AGENT_ID.test(agent)) return { surface: 'inbox', conversation: agent }
  }
  return { surface: 'inbox', conversation: null }
}

/**
 * Which interface a location's fragment asks for.
 *
 * Anything that is not the Epsilon fragment is the inbox: a bare URL, a stale
 * bookmark carrying some other fragment, the conversation form this module also
 * owns, and the deployment's own app at a different path all have to keep
 * landing on the surface people already use.
 * @param hash - `location.hash`, with or without the leading `#`.
 * @returns the interface this page load paints.
 */
export function surfaceOf(hash: string): HarnessSurface {
  return bootIntentOf(hash).surface
}

// ─── the message contract ───────────────────────────────────────────────────
// One shell, two interfaces, ONE document — so the wrapper page switches what
// the app shows instead of loading another document. These three words are the
// whole wire, frozen beside the e-server route that speaks them
// (api/routes.py's `_harness_frame`): the parent posts {@link OPEN_MESSAGE} to
// this window with an exact `targetOrigin`, and this app answers
// {@link READY_MESSAGE} once it can receive and {@link ROUTE_MESSAGE} whenever
// the person navigates inside it, so the parent can keep the browser URL and
// the menu's selected entry in step without loading anything.

/** Parent to app: show this address. */
export const OPEN_MESSAGE = 'dsh:open'

/** App to parent: the app can receive an {@link OPEN_MESSAGE}. */
export const READY_MESSAGE = 'dsh:ready'

/** App to parent: the person navigated inside the app. */
export const ROUTE_MESSAGE = 'dsh:route'

/**
 * One {@link OPEN_MESSAGE} this app accepts: the address to show, plus the
 * token the parent wants echoed in {@link READY_MESSAGE}.
 */
export interface OpenIntent extends BootIntent {
  /**
   * Opaque parent-side correlation value, echoed back untouched. Absent reads
   * as the empty string, so a parent that has not minted one yet still
   * completes the handshake.
   */
  readonly token: string
}

/**
 * Sentinel for a `conversation` field this app cannot address. Distinct from
 * `null`, which means "no conversation asked for": a bad word is a protocol
 * violation and the WHOLE message is dropped, never half-applied.
 */
const INVALID = Symbol('invalid conversation')

/**
 * Whether a word names one of the two interfaces.
 * @param value - any value, typically off the wire.
 * @returns true when the value is a surface this app paints.
 */
export function isHarnessSurface(value: unknown): value is HarnessSurface {
  return value === 'inbox' || value === 'epsilons'
}

/**
 * Read one `conversation` field.
 * @param value - the field as it arrived.
 * @returns the agent id, null for "none asked for", or {@link INVALID}.
 */
function conversationOf(value: unknown): string | null | typeof INVALID {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !AGENT_ID.test(value)) return INVALID
  return value
}

/**
 * Validate one message off `window`, WITHOUT trusting its origin (the caller
 * checks {@link OPEN_MESSAGE}'s sender first: only this app's parent may move
 * it).
 *
 * Strict on purpose: a `surface` this app does not paint, a conversation that
 * is not an agent id this app could open, or a `token` that is not a string
 * means the sender and this app disagree about the contract, and applying half
 * of such a message would put the app in a state neither side asked for. The
 * three words and the two surfaces are the only shape accepted.
 * @param data - `event.data` from a `message` event.
 * @returns the intent to apply, or null when the message is not one of ours.
 */
export function openIntentOf(data: unknown): OpenIntent | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as { type?: unknown; surface?: unknown; conversation?: unknown; token?: unknown }
  if (message.type !== OPEN_MESSAGE) return null
  if (!isHarnessSurface(message.surface)) return null
  if (message.token !== undefined && typeof message.token !== 'string') return null
  const conversation = conversationOf(message.conversation)
  if (conversation === INVALID) return null
  return { surface: message.surface, conversation, token: message.token ?? '' }
}
