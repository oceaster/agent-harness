# Agent Note: Agent channel chat pages

Status: implemented

English | [中文](2026-10-20-agent-channel-chat-pages.zh.md)

## Problem

A modal channel transcript prevents ordinary navigation between an agent inbox and peer coordination. Channel rows also need the same width, selection feedback and Clear menu as agent rows.

## Decision

The layout owns a root-scoped `conversation.page` list slot and selects one page by registration id through `layout.openPage`. A null page restores the selected session. The inbox owns channel selection and history, registers the read-only channel page, and selects it when a channel row opens. Selecting an agent restores the conversation without creating a channel session or interrupting ongoing work.

Channel rows use the inbox row structure and its dropdown confirmation flow. Clear remains a per-person API operation. Only confirmation uses a modal; channel content occupies the center chat tile.

## Alternatives considered

**Modal transcript.** Rejected because the transcript is a primary reading destination and must leave sidebar navigation usable.

**Synthetic agent session.** Rejected because peer coordination has its own history and ownership; pretending it is an agent session introduces an input path and model lifecycle it does not own.

## Consequences

The layout has a transient center-page selection in addition to session selection. Channel selection resets on reload, while agent history and drafts remain owned by their existing session controllers. Opening a center page closes the details column. Component checks cover center-page navigation and dropdown confirmation; the e-server Chromium fixture verifies actual tile placement, equal row widths, no input controls, Clear and return to agent composition.
