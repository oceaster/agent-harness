# Agent Note: Pending subagent queue deletion

Status: implemented

English | [中文](2026-10-13-subagent-queue-deletion.zh.md)

## Problem

A resident subagent's pending next-turn occurrences were fixed once accepted. `session.updateQueue` refused every verb on a session the `hasSubagentOwner` fence classifies as a child, and `QueueDock` consequently rendered those rows as a read-only projection with no action at all. A person who queued a follow-up while the child was still working could not take it back: the only remaining controls were Stop (which aborts the child's current turn) or steering a child the continuation transport does not steer.

The inbox itself already supported exact occurrence removal. The refusal was a Host policy decision taken before a continuation transport existed that made those rows visible in the dock, so it outlived its reason.

## Decision

`session.updateQueue` splits the queue verbs by ownership instead of refusing all of them. The same `hasSubagentOwner` fence that guards `prompt`, `cancel`, `models` and `destroy` still rejects `edit`, `steer` and any addressed item that lives in `next-step`, all with `agent-busy`. `remove` on a `next-turn` occurrence of a resident subagent proceeds: it addresses the exact `MessageId` and runs the existing `Inbox.remove` durable splice, which is the whole effect on the child. Nothing cancels the active turn, steers, resumes a cold session or moves the child under another owner.

`QueueDock` renders its action strip for every row and gates only the edit and strict-steer buttons behind `queueMutable` (the ordinary-session flag), so a child's row offers deletion alone. Interaction state — an in-flight mutation — keeps rows visible regardless of that flag. The dock never splices its own list: `applyAction` awaits the RPC and a row retires only when the authoritative `session/queue` snapshot drops it, which is the reconcile rule ordinary sessions already followed, so a refused removal leaves the row in place and reports the failure.

An occurrence a claim already consumed leaves a pure deletion splice behind, so a later removal answers `queue-item-not-found` rather than resurrecting anything, and the browser never infers retirement from turn or status events.

## Alternatives considered

- **A subagent-specific deletion route (`subagent.updateQueue` or similar).** The session-scoped route already carries authenticated session ownership and exact-occurrence addressing, and a child is addressed by its own session id there. A second route would duplicate that contract, split the browser's reconcile path in two and drift from the ordinary-session behaviour a person already knows.
- **Exposing edit and strict steer on child queues too.** A continuable follow-up is delivered as a waking send, so there is no admitted window in which replacement content or a mid-turn steer could be honoured. Offering those verbs would promise a delivery shape the continuation transport does not have, and the refusal would then arrive after the person had already committed the edit.
- **Cancelling the child and restarting it with the remaining queue.** That is the failure this work has to avoid: retracting one queued follow-up would end the child's current turn, which is the opposite of the request. Removal touches the inbox and nothing else.
- **Removing the row optimistically in the dock.** The queue is a projection of durable `agent/inbox/spliced` mutations; a local splice would show a row gone while the Host still holds it, and would have to be undone when a refusal or a different authority arrived. Waiting for the snapshot is the same rule the ordinary-session rows obey.

## Consequences

A person can retract a queued follow-up while a child keeps working, which is the whole point: the child's active turn, its ownership and its FIFO continuation are untouched, and the surviving occurrences still run in their original order, including across Stop (which keeps the inbox). The child stays a resident Activation: no resume, no reparent, no re-drive.

The risk this buys is a deletion path that quietly ends a turn, so the guarantee is pinned where it would break rather than only at the RPC boundary — a real loop, a real continuable child and a gated model call assert that the open turn survives the splice, that the retracted text never runs and that the kept occurrence runs in its FIFO place. A future change that turns removal into cancel-and-restart fails that test.

Ownership stays single-sourced: the fence is still `hasSubagentOwner`, so the queue cannot drift from the other generic routes. The subagent idle reaper skips a session whose Agent holds queued work, so a child parked on a follow-up is not reaped while it waits, and retracting one occurrence does not expose it either: the surviving occurrences keep it busy, and an emptied queue only makes it eligible on a later pass.

## Testing

- `packages/host/apiproxy/tests/api-proxy-cold.spec.ts` — a resident child's exact occurrence is removed durably through `session.updateQueue`; identical content under distinct ids retires only the addressed one; a replayed removal answers `queue-item-not-found`; a `next-step` occurrence, an edit and a steer each answer `agent-busy`; no `cancel`, no `steer`, no `resume`, and the Agent's status is unchanged. A second case proves an ordinary session beside the child keeps edit, steer and removal, and that the child's queue never reaches it.
- `packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` — a child row offers deletion and no edit or steer, and the dock retires the row only when a snapshot without it arrives, never at RPC resolution.
- `packages/subagent/subagent/tests/continuation.spec.ts` — with a real loop and a gated model call, the splice leaves the open child turn running and the kept occurrence runs afterwards in FIFO order; Stop after a retraction still parks both survivors and delivers them ahead of a waking send.
- `apps/web/tests/subagent-interrupt-ui.e2e.ts` with the golden `snapshots/subagent-interrupt/child-queue-delete.expected.md` — the browser scenario: queue two child messages, delete each through the dock with a reload between deletions, and observe the original child turn still open. The apps/web lane carries unrelated failures at this base, so the scenario's actual result is reported in the porting ticket rather than claimed here.
