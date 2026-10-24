/**
 * The one occupant of `sidebar.workspaces`: BOTH interfaces of the one shell,
 * mounted once, with "closed" meaning "not visible".
 *
 * Owen, 2026-10-24: "The Agent-Harness should always be rendered and rendering
 * (or at least in theory) - if closed, it's actually just 'not-visible'. Both
 * Delta and Epsilon tabs (via either drop down journey) both views the inbox and
 * the sub-agent views should also apply this logic down the tree, so the user
 * get's an instantaneous flow when quickly moving around their environment."
 *
 * WHY A WRAPPER AND NOT A SWAPPABLE SLOT. `sidebar.workspaces` is declared
 * `kind: 'single'`, and the slot registry THROWS on a second occupant at the
 * same priority (ui-slots index.ts, the `single` case) — two registrations are
 * not an option, and re-registering mid-session would dispose the live entry and
 * mount a fresh one, which is precisely the remount this exists to avoid (the
 * entry's inject hooks are cached per entry, so a new entry is a new panel with
 * new state). Growing the layout slot a "swap the mounted occupant" verb would
 * change the single-consumer rule for every slot in the app to solve a decision
 * that belongs to this package. So the wrapper IS the single occupant and the
 * switch is internal: one registration, two panels, one visible.
 *
 * WHAT IS HIDDEN AND WHAT IS QUIET. The hidden panel is mounted but asleep: its
 * store hook is gated (surface-gate.ts), so while hidden it holds no
 * subscription at all — no store frame re-renders it, no timer wakes it, and its
 * DOM keeps whatever the person left in it (an open row menu, a confirm dialog,
 * a scroll offset) because nothing unmounts. Everything else that could keep
 * working while hidden lives in index.ts and is gated on the same word: the
 * agent-channel poll runs only while the inbox surface is showing, and Delta's
 * sub-agent roster is read only while the Epsilon surface is.
 *
 * WHICH SURFACE IS MOUNTED, and the one compromise here: a surface mounts the
 * first time it is SHOWN, and never unmounts afterwards. A page nobody drives by
 * message therefore still contains exactly one interface — the composed checks
 * that hold the two interfaces apart by markup ("the inbox paints no sub-agent
 * row", "no inbox agent row may be on the epsilon interface at all") stay true
 * on a cold load. As soon as the parent posts one `dsh:open`
 * (`SurfaceSnapshot.resident`), both are mounted and every later move is a
 * visibility flip.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { EpsilonPanel } from './EpsilonPanel.tsx'
import { InboxPanel } from './InboxPanel.tsx'
import { useGatedHook } from './surface-gate.ts'
import type { InboxPanelProps } from './slots.ts'
import css from './SurfacePanels.module.css'

/**
 * Render both interfaces of the shell, showing the one the parent asked for.
 * @param props - composed slot props, forwarded to whichever panel renders.
 * @returns both panes, one of them hidden.
 */
export function SurfacePanels(props: InboxPanelProps) {
  const { surface, sources } = props
  // Stable closures: uSES resubscribes when `subscribe` changes identity, and
  // the surface store changes a handful of times per session, not per frame.
  const subscribe = useMemo(() => (notify: () => void) => surface.subscribe(notify), [surface])
  const read = useMemo(() => () => surface.getSnapshot(), [surface])
  const showing = useSyncExternalStore(subscribe, read)
  const inboxShown = showing.surface === 'inbox'

  // What has been mounted at least once. `resident` mounts both as soon as the
  // parent proves it drives navigation; the surface being shown mounts itself.
  const [mounted, setMounted] = useState<{ inbox: boolean; epsilons: boolean }>(
    () => ({ inbox: inboxShown, epsilons: !inboxShown }),
  )
  useEffect(() => {
    setMounted((current) => {
      if (showing.resident) return current.inbox && current.epsilons ? current : { inbox: true, epsilons: true }
      if (current[showing.surface]) return current
      return { ...current, [showing.surface]: true }
    })
  }, [showing.resident, showing.surface])

  // One gated hook per panel/store pair: the visible surface listens, the hidden
  // one is frozen until it is shown again.
  const inboxState = useGatedHook(sources.inbox, inboxShown)
  const channelsState = useGatedHook(sources.channels, inboxShown)
  const workersState = useGatedHook(sources.inbox, !inboxShown)

  return (
    <>
      {mounted.inbox && (
        <div className={css.pane} data-surface="inbox" data-testid="ui-surface-inbox" hidden={!inboxShown}>
          <InboxPanel {...props} useInbox={inboxState} useChannels={channelsState} />
        </div>
      )}
      {mounted.epsilons && (
        <div className={css.pane} data-surface="epsilons" data-testid="ui-surface-epsilons" hidden={inboxShown}>
          <EpsilonPanel {...props} useInbox={workersState} />
        </div>
      )}
    </>
  )
}
