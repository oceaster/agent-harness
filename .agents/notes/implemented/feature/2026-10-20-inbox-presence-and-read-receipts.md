# Agent Note: Inbox presence and read receipts

Status: implemented

English | [中文](2026-10-20-inbox-presence-and-read-receipts.zh.md)

## Problem

A missing row hides a supported but disabled agent. Running, finished-unread and terminal-failure states also need distinct indicators without treating transient model retries as fatal errors.

## Decision

The authenticated inbox lists the person's recorded roster, including disabled and unavailable agents. Disabled rows cannot open or clear a conversation. Agent dots are green for online, red for offline, white for running, blue for an unread completion and amber for a terminal turn error. Channels retain read-only history while offline; their online state requires both participants to be available.

The host event stream supplies completed-turn sequences and terminal outcomes. The backend persists these per canonical person/agent inbox. A visible, selected, idle inbox acknowledges exactly the completion sequence it displayed; the backend bounds that acknowledgment to the current completion. A later completion remains unread. Channel and sub-agent views do not acknowledge a parent inbox.

## Alternatives considered

**Client-only running transitions.** Rejected because they lose unread and failure state across reloads and cannot distinguish a fatal turn error from a normal stop.

**Any warning means fatal failure.** Rejected because recoverable tool failures and model retries are normal parts of ongoing work.

## Consequences

Unread markers persist across devices for the same person. Status polling adds bounded metadata reads without model requests. Ingested events update idle outcomes; live session frames retain priority for running work. Clearing a conversation resets its markers, with a timestamp barrier against delayed old events. Existing history has no inferred unread baseline; completion tracking follows the trusted event stream.
