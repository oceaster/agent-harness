// @vitest-environment jsdom
// The React affordance's client half: the button, its emoji table, and the
// badge the log folds back.
//
// The shape this pins is the one the owner asked for. A click writes one note
// through `session.react` and rendering stops there — nothing is painted
// optimistically, no store of our own holds a reaction, and the badge appears
// only when the note the host streams comes back as a `reaction/note` fold.
// Un-react and change are their own acts with their own `action`, decided from
// the glyph the log already records rather than from local state, so a reload
// reaches the same conclusion.
//
// Two failure modes are asserted here because both ship by accident:
// - a claimed success before the log answers (the table would show a badge the
//   session never recorded);
// - a refused write hidden behind that claim (the host's refusal text is
//   surfaced and the row is otherwise untouched).
//
// The transcript-level claim — a reaction adds a badge and nothing else, never
// a chat row — lives in chat-view.client.spec.tsx, where the assembled
// transcript is rendered; and the host-side invisibility of the note itself is
// pinned by reaction-note-transcript.client.spec.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionReaction, SessionReactionAction } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeReaction } from '../src/client/contract/slots.ts'
import { EmojiTable, REACTION_EMOJI } from '../src/client/chat/EmojiTable.tsx'
import { MessageIconActions } from '../src/client/chat/MessageIconActions.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

// Mirrors the real lookup chain (conversation namespace, then common).
const t = makeTranslate(zh, commonZh)

/** One reaction as the log fold renders it. */
function note(over: Partial<SessionReaction> = {}): SessionReaction {
  return { targetSeq: 7, emoji: '👍', action: 'added', actor: 'user', seq: 11, ...over }
}

/**
 * A reaction face with a spied note writer, failing or resolving on demand.
 * @returns the face to hand MessageIconActions, plus its spy.
 */
function face(reaction?: SessionReaction) {
  const react = vi.fn<(emoji: string, action: SessionReactionAction) => Promise<void>>()
    .mockResolvedValue(undefined)
  const value: ChatNodeReaction = { reaction, react }
  return { value, react }
}

/** Render one actions row with an optional reaction face. */
function renderActions(reaction: ChatNodeReaction | undefined) {
  return render(
    <MessageIconActions
      text="a message body"
      time={1_000}
      clock="start"
      {...reaction === undefined ? {} : { reaction }}
      t={t}
    />,
  )
}

/** The React trigger's accessible name in the shipped Chinese dictionary. */
const REACT_LABEL = zh['reaction.button']
/** Copy arrives from the common dictionary, not this package's own. */
const COPY_LABEL = commonZh.copy

describe('reaction copies', () => {
  it('both dictionaries carry the same reaction keys, with no placeholder drift', () => {
    const keys = Object.keys(zh).filter(key => key.startsWith('reaction.'))
    expect(keys.sort()).toEqual([
      'reaction.button', 'reaction.current', 'reaction.failed', 'reaction.option', 'reaction.table',
    ])
    for (const key of keys) {
      expect(Object.hasOwn(en, key)).toBe(true)
      // A translated string that drops a placeholder loses the emoji or the
      // refusal reason the sentence exists to carry.
      const placeholders = (value: string): string[] => (value.match(/\{\w+\}/g) ?? []).sort()
      expect(placeholders((en as Record<string, string>)[key]!)).toEqual(placeholders((zh as Record<string, string>)[key]!))
    }
  })
})

describe('the React affordance', () => {
  it('carries copy and react, and only those', () => {
    const { value } = face()
    renderActions(value)
    const labels = screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))
    expect(labels).toEqual([COPY_LABEL, REACT_LABEL])
    // The affordances the owner removed stay removed: no branch, no rating.
    for (const gone of ['分支', '在新对话中分支', 'Good response', 'Bad response', 'Remove rating']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
  })

  it('offers no React button on a row with no durable message to target', () => {
    renderActions(undefined)
    expect(screen.queryByRole('button', { name: REACT_LABEL })).toBeNull()
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([COPY_LABEL])
  })

  it('opens the emoji table and closes it again from the same button', () => {
    const { value } = face()
    renderActions(value)
    const trigger = screen.getByRole('button', { name: REACT_LABEL })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox', { name: zh['reaction.table'] })).toBeTruthy()
    // Pressing the trigger again is a toggle: the table closes rather than
    // closing on the pointer press and reopening on the click behind it.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Escape and hands focus back to the React button', () => {
    const { value } = face()
    renderActions(value)
    const trigger = screen.getByRole('button', { name: REACT_LABEL })
    fireEvent.click(trigger)
    const table = screen.getByRole('group', { name: zh['reaction.table'] })
    fireEvent.keyDown(table, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on an outside click and hands focus back to the React button', () => {
    const { value } = face()
    renderActions(value)
    const trigger = screen.getByRole('button', { name: REACT_LABEL })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('is labelled and keyboard navigable, and marks the glyph the log records', () => {
    const { value } = face(note({ emoji: '🔥' }))
    renderActions(value)
    fireEvent.click(screen.getByRole('button', { name: REACT_LABEL }))
    const table = screen.getByRole('group', { name: zh['reaction.table'] })
    const listbox = within(table).getByRole('listbox', { name: zh['reaction.table'] })
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(REACTION_EMOJI.length)
    // Every entry is labelled with its glyph for a reader that cannot see it.
    for (const [index, glyph] of REACTION_EMOJI.entries()) {
      expect(options[index]!.getAttribute('aria-label')).toBe(zh['reaction.option'].replace('{emoji}', glyph))
    }
    // The applied glyph is marked, and focus opens on it so "choose it again
    // to un-react" is the reader's first option.
    const applied = within(listbox).getByRole('option', { name: zh['reaction.option'].replace('{emoji}', '🔥') })
    expect(applied.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(applied)
    // Arrow keys walk the grid; the vertical step is the row length, wrapping
    // around the fixed set.
    const start = REACTION_EMOJI.indexOf('🔥')
    fireEvent.keyDown(table, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(options[(start + 1) % REACTION_EMOJI.length])
    fireEvent.keyDown(table, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[(start + 1 + 6) % REACTION_EMOJI.length])
    fireEvent.keyDown(table, { key: 'End' })
    expect(document.activeElement).toBe(options.at(-1))
  })
})

describe('choosing a glyph posts one note', () => {
  it('fires session.react with the chosen glyph and closes without a badge', () => {
    const { value, react } = face()
    renderActions(value)
    fireEvent.click(screen.getByRole('button', { name: REACT_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: zh['reaction.option'].replace('{emoji}', '🎉') }))
    // Mutation check: the glyph travels, not a stand-in, and the act is `added`
    // because the log records no reaction for this message yet.
    expect(react).toHaveBeenCalledTimes(1)
    expect(react).toHaveBeenCalledWith('🎉', 'added')
    expect(screen.queryByRole('listbox')).toBeNull()
    // No optimistic badge: the row paints nothing the log has not recorded.
    expect(screen.queryByRole('img', { name: /当前回应/ })).toBeNull()
    expect(document.querySelector('[data-reaction-badge]')).toBeNull()
  })

  it('records a change when a different glyph replaces the applied one', () => {
    const { value, react } = face(note({ emoji: '👍', action: 'added' }))
    renderActions(value)
    fireEvent.click(screen.getByRole('button', { name: REACT_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: zh['reaction.option'].replace('{emoji}', '😢') }))
    expect(react).toHaveBeenCalledWith('😢', 'changed')
    // The badge still shows the glyph the log carries: the change is not local.
    expect(document.querySelector('[data-reaction-badge]')?.textContent).toBe('👍')
  })

  it('records a removal when the applied glyph is chosen again', () => {
    const { value, react } = face(note({ emoji: '👍', action: 'added' }))
    renderActions(value)
    fireEvent.click(screen.getByRole('button', { name: REACT_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: zh['reaction.option'].replace('{emoji}', '👍') }))
    expect(react).toHaveBeenCalledWith('👍', 'removed')
    expect(document.querySelector('[data-reaction-badge]')).not.toBeNull()
  })

  it('paints the badge when the note comes back in the log', () => {
    const { value } = face()
    const view = renderActions(value)
    expect(document.querySelector('[data-reaction-badge]')).toBeNull()
    // The note streams back: the session's fold now carries the reaction, and
    // the row is re-rendered from it.
    view.rerender(
      <MessageIconActions text="a message body" time={1_000} clock="start" reaction={face(note({ emoji: '❤️' })).value} t={t} />,
    )
    const badge = document.querySelector('[data-reaction-badge]')
    expect(badge?.textContent).toBe('❤️')
    // The badge names the glyph: an emoji alone is not readable copy.
    expect(badge?.getAttribute('aria-label')).toBe(zh['reaction.current'].replace('{emoji}', '❤️'))
    expect(screen.getByRole('img', { name: zh['reaction.current'].replace('{emoji}', '❤️') })).toBeTruthy()
  })

  it('surfaces a refused write and claims nothing', async () => {
    const { value, react } = face()
    react.mockRejectedValueOnce(new Error('target-not-valid: target 7 is not an append-origin message'))
    renderActions(value)
    fireEvent.click(screen.getByRole('button', { name: REACT_LABEL }))
    fireEvent.click(screen.getByRole('option', { name: zh['reaction.option'].replace('{emoji}', '✅') }))
    // The table closes, and the refusal is shown with the host's own reason.
    expect(screen.queryByRole('listbox')).toBeNull()
    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(zh['reaction.failed'].replace('{reason}', 'target-not-valid: target 7 is not an append-origin message'))
    // Nothing about the message changed: no badge, no claim of success.
    expect(document.querySelector('[data-reaction-badge]')).toBeNull()
  })
})

describe('the emoji table', () => {
  it('closes when an entry is chosen', () => {
    const onChoose = vi.fn<(emoji: string) => void>()
    const onDismiss = vi.fn()
    const anchor = { current: null }
    render(
      <div ref={(element) => { anchor.current = element }}>
        <EmojiTable id="table" anchor={anchor} current={undefined} onChoose={onChoose} onDismiss={onDismiss} t={t} />
      </div>,
    )
    fireEvent.click(screen.getByRole('option', { name: zh['reaction.option'].replace('{emoji}', '😄') }))
    // The choice is the parent's to make (it posts the note and closes); the
    // table itself only reports it and never claims a badge of its own.
    expect(onChoose).toHaveBeenCalledWith('😄')
    expect(onDismiss).not.toHaveBeenCalled()
    expect(document.querySelector('[data-reaction-badge]')).toBeNull()
  })
})
