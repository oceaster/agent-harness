# Agent Note: Pending subagent queue deletion

Status: implemented

[English](2026-10-13-subagent-queue-deletion.md) | 中文

## Problem

常驻 subagent 已受理的 `next-turn` 单次入队项一旦入队便无法更改。`session.updateQueue` 对被 `hasSubagentOwner` 判定为 child 的会话拒绝所有动词，`QueueDock` 也因此把那些行列成只读投影，完全不提供操作。人在 child 仍在工作时排入一条 follow-up 之后就无法收回：剩下的控件只有 Stop（会中止 child 当前轮次），或者对继续执行传输根本不支持 steering 的 child 做 steering。

inbox 本身早已支持精确单次入队项的移除。那次拒绝是 Host 的策略决定，做出它的时间早于让这些行出现在 dock 里的继续执行传输，因此它比自己的理由活得更久。

## Decision

`session.updateQueue` 不再按归属整体拒绝队列动词，而是按动词拆分。守卫 `prompt`、`cancel`、`models` 与 `destroy` 的同一个 `hasSubagentOwner` 围栏仍然拒绝 `edit`、`steer`，以及任何定位到 `next-step` 的项，全部以 `agent-busy` 拒绝。常驻 subagent 的 `next-turn` 单次入队项上的 `remove` 放行：它按精确 `MessageId` 寻址，执行既有的 `Inbox.remove` 持久 splice，这就是对 child 的全部影响。不会取消活动轮次、不会 steering、不会恢复冷会话，也不会把 child 移到别的所有者之下。

`QueueDock` 为每一行渲染操作区，只把编辑与严格 steering 按钮挡在 `queueMutable`（普通会话标志）之后，因此 child 的行只提供删除。交互状态——正在进行的变更——无论该标志如何都保持行可见。dock 绝不自行 splice 列表：`applyAction` 等待 RPC，行只在权威 `session/queue` 快照不再包含它时退出，这正是普通会话原本就遵循的对账规则；因此被拒绝的移除会保留该行并报告失败。

已被认领消费的单次入队项只会留下纯删除 splice，所以之后的操作返回 `queue-item-not-found`，而不是复活任何东西；浏览器也绝不根据轮次或状态事件推断某项已退出队列。

## Alternatives considered

- **专门为 subagent 增加一条删除路由（类似 `subagent.updateQueue`）。** 会话作用域的路由本身已携带经过认证的会话归属信息与精确单次入队项寻址，child 在那里正是以自身 session id 被寻址。第二条路由会复制该约定、把浏览器的对账路径一分为二，并与人们已经熟悉的普通会话行为逐渐分叉。
- **在 child 队列上同样开放编辑与严格 steering。** 可继续执行的 follow-up 以唤醒式发送投递，因此不存在能够被接纳的窗口去应用替换内容或中途 steering。提供这些动词等于承诺继续执行传输并不具备的投递形态，而拒绝会等到人已经提交编辑之后才出现。
- **取消 child 并以剩余队列重新启动。** 这正是本次工作必须避免的失败：撤回一条排队 follow-up 会结束 child 当前轮次，与请求完全相反。移除只触碰 inbox，别无其他。
- **在 dock 里乐观移除该行。** 队列是持久 `agent/inbox/spliced` 变更的投影；本地 splice 会显示该行已消失而 Host 仍持有它，并且在遇到拒绝或另一个权威时还得撤销。等待快照与普通会话行遵守的是同一条规则。

## Consequences

人可以在 child 继续工作的同时撤回排队 follow-up，这正是要点：child 的活动轮次、归属与 FIFO 继续执行都不受影响，存活的单次入队项仍按原有顺序执行，包括跨越 Stop（Stop 保留 inbox）之后。child 仍是同一个常驻 Activation：不恢复、不改挂父级、不重新驱动。

这样换来的风险是一条会静悄悄结束轮次的删除路径，因此该保证被钉在真正会出问题的地方，而不只是 RPC 边界——真实的 loop、真实的可继续执行 child 与被闸住的模型调用共同断言：活动轮次在 splice 后存活、被撤回的文本绝不执行、保留项仍在其 FIFO 位置执行。将来若把移除改成 cancel-and-restart，该测试就会失败。

归属仍保持单一来源：围栏依旧是 `hasSubagentOwner`，队列不会与其它通用路由产生偏差。subagent 空闲回收器会跳过 Agent 仍持有队列工作的会话，因此停在 follow-up 上等待的 child 不会被回收；撤回其中一条也不会让它变得可回收：存活的单次入队项让它继续忙碌，只有队列真正清空后才可能在之后的某一轮被纳入。

## Testing

- `packages/host/apiproxy/tests/api-proxy-cold.spec.ts` —— 通过 `session.updateQueue` 持久移除常驻 child 的精确单次入队项；内容相同但 id 不同的两项只会退掉被寻址的那一项；重复的移除返回 `queue-item-not-found`；`next-step` 项、编辑与 steering 均以 `agent-busy` 拒绝；没有 `cancel`、没有 `steer`、没有 `resume`，Agent 状态不变。第二个用例证明 child 旁的普通会话仍保留编辑、steering 与移除，而 child 的队列永远不会到达它。
- `packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` —— child 行提供删除、不提供编辑或 steering；并且 dock 只在收到不含该行的快照时才退掉该行，绝不在 RPC 返回时退掉。
- `packages/subagent/subagent/tests/continuation.spec.ts` —— 在真实 loop 与被闸住的模型调用下，splice 之后 child 的活动轮次仍在运行，保留项随后按 FIFO 顺序执行；撤回之后再 Stop，仍会停放两条存活项，并让它们在唤醒式发送之前投递。
- `apps/web/tests/subagent-interrupt-ui.e2e.ts` 及基准 `snapshots/subagent-interrupt/child-queue-delete.expected.md` —— 浏览器场景：排队两条 child 消息，经 dock 逐条删除并在这两次删除之间重新加载，观察原始 child 轮次仍然开启。该基线上的 apps/web 通道带有无关失败，因此该场景的真实结果在移植工单中报告，而不是在此声称。
