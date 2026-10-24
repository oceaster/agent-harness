/**
 * Which interface this page load is: ONE shell, TWO interfaces.
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
 * Which interface a location's fragment asks for.
 *
 * Anything that is not the Epsilon fragment is the inbox: a bare URL, a stale
 * bookmark carrying some other fragment, and the deployment's own app at a
 * different path all have to keep landing on the surface people already use.
 * A trailing slash is tolerated because a pasted link is written by hand.
 * @param hash - `location.hash`, with or without the leading `#`.
 * @returns the interface this page load paints.
 */
export function surfaceOf(hash: string): HarnessSurface {
  const fragment = hash.replace(/\/+$/, '')
  return fragment === EPSILONS_FRAGMENT || fragment === EPSILONS_FRAGMENT.slice(1)
    ? 'epsilons'
    : 'inbox'
}
