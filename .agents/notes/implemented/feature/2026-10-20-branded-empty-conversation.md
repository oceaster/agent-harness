# Agent Note: Branded empty conversation

Status: implemented

English | [中文](2026-10-20-branded-empty-conversation.zh.md)

## Problem

Opening a conversation with no messages showed the harness's own empty state: an "Into the Unknown" headline, a "Preview" badge, and the composer card centered vertically in the column. The household already renders a branded welcome screen one state over — when no conversation is selected at all — so the first thing a person saw on opening an agent was someone else's empty state, and the first message moved the composer from the middle of the column to its floor.

## Decision

An empty conversation is the ordinary active layout with the household mark in the body. The conversation body holds the same art the welcome screen uses (the `HeroGlow` ellipse plus the brand mark masked into a soft gradient), centered in a flex-filling container carrying `data-testid="conversation-empty"`; the composer keeps its docked sticky seat, its card geometry, and its ordinary placeholder, so sending the first message neither moves nor resizes it, and the mark disappears when the transcript starts. The composer bar no longer has a centered variant: one geometry serves an empty conversation and an active one.

The mark states that the conversation has no messages, so it is painted only when emptiness is known: the session's own open landed, or the session-list summary proves it blank — the same proof the deleted hero required. A session whose open is in flight or has failed keeps a bare body, because ChatView renders its history failure in the same body and an art block there would present a transcript nobody could read as an empty conversation.

The empty-state headline chrome is deleted rather than hidden. `HeroShell` and `HeroShell.module.css` are gone, the `hero.headline` / `hero.preview` / `placeholder.hero` locale keys are gone in both languages, and the root reports only `active` and `settling`. The shared backdrop moved to `HeroGlow.tsx`, the one export that still had a caller.

`settling` is unchanged: while a blank session's open is still loading and the session-list summary does not yet prove it blank, the composer seat stays hidden — the readiness gate withholds the placeholder there too, and for a failed or unstarted open, because an art block that flashes and then gives way to a transcript reads as a page reload for the same reason the hidden composer did. A session the summary already proves blank skips settling and shows the placeholder immediately.

## Alternatives considered

**Keep the hero phase and restyle it.** Rejected: the phase existed only to center a card and a headline, and both are gone. Leaving the phase would keep `data-phase='hero'`, the centered stack and the hero composer variant alive as dead states that every future layout change has to reason about.

**Hide the headline but keep the centered card.** Rejected because it keeps the defect the person reported: the composer would still jump to the floor on the first message.

**Reuse the welcome screen as one component for both states.** Rejected: the welcome screen owns the footer and the prompt and has no composer, so sharing it would mean a mode flag on every element. The shared part is the art, and that is what was extracted.

## Consequences

The assembled UI has no harness-authored empty-state copy, so `apps/web/tests`' hero anchors (`Into the Unknown`, the hero placeholder, `data-phase="hero"`) became the placeholder test id and the ordinary placeholder; the two lifecycle-chrome goldens lost the headline line and re-recorded the composer placeholder. `EmptyHero.tsx` is renamed to `HeroGlow.tsx`. The `conversation.hero.agentPreset` slot keeps its name even though no surface renders it, because no chip is registered on the empty conversation either.

The placeholder carries no text and is `aria-hidden`, so an empty conversation has no accessible description of its own; the composer's placeholder is the only cue, which is what an active conversation offers too.

## Verification

`packages/client/ui-conversation` vitest pins the placeholder's presence in an empty conversation, its absence while settling, after the first message, and for a session whose emptiness is unproven (`cold` or failed open, snapshot not blank, no summary proof), the sibling order of placeholder and composer seat inside `[data-conversation-scroll]`, the `active` phase, and the ordinary composer placeholder. Reverting the source change fails those assertions, and reverting only the readiness gate fails the unproven-emptiness case.

The browser probe in `tests/fixture/` proves the readable-open path in a real engine (placeholder painted with the brand mask, composer geometry unchanged across the first message, no horizontal scrollbar at 480px). It cannot exercise the failed or `cold` open: the fixture intercepts HTTP, while the conversation's history round-trip rides the RPC uplink, so the client never reaches `openState='error'` there. That state is pinned at the unit layer only.
