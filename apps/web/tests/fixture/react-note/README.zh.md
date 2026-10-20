# 反应笔记夹具（工单 `f1bdaed3`）

[English](README.md) | 中文

在**真正构建出的 harness** 上度量反应功能的 host 半部：隔离的 `DSH_HOME`、记录型
mock provider，以及浏览器实际使用的同一个 HTTP 客户端请求载体。不 patch 任何产品
文件，不消耗 API 额度，也不会写入线上 `DSH_HOME`。

设计文档：已验收的 spike，
`NOTE-ONLY-DO-NOT-TOUCH-PRODUCT-SOURCE/reaction-note-spike.md`（位于
`feat/react-note-spike`，`9d0684d166`）。本夹具与 spike 的夹具有一处决定性差异：
笔记是通过**真实的 `session.react` RPC** 追加的。spike 当时必须用探针插件伸手进
host，因为那时没有可用的 RPC，所以它那条「追加不会启动任何东西」的结论针对的是手写
追加；这里的结论针对客户端真正会调用的那条线上路径。

## 文件

| 文件 | 作用 |
| --- | --- |
| `start-react-note-fixture.sh` | 用隔离 home、mock provider，并把观察插件作为 home patch 行，启动 `apps/cli/lib/bin.js --profile web` |
| `mock-llm.mjs` | 兼容 OpenAI 的替身，记录每个请求体；SSE 行复制自 `packages/llm/llm-deepseek/tests/mock-server.ts` |
| `observe-plugin.mjs` | 只做观察的 host 路由（`/react-note-observe`）：事件计数、派生消息列表、agent 状态、inbox 深度、surface 节点 |
| `drive-react-note.mjs` | 度量本体：负向、投影索引、compaction |
| `restart-check.sh` / `restart-check.mjs` | 停掉 host，在同一 `DSH_HOME` 上启动同一构建，证明会话仍能打开 |
| `evidence/` | 工单提交中记录的那次运行的转储（`react-note-drive.json`、`react-note-restart.json`）；drive 转储里过长的组装 prompt 体被截断，且截断事实写在文件内部 |

## 运行方式

```sh
# From the repository root, after a full build (NOT build:lib:host alone:
# the web profile boots client bundles and apps/web/dist).
npm run clean && pnpm install --frozen-lockfile && npm run build

bash apps/web/tests/fixture/react-note/start-react-note-fixture.sh 3611 3612
MOCK_URL=http://127.0.0.1:3612 DRIVER_CWD=/tmp \
  node apps/web/tests/fixture/react-note/drive-react-note.mjs \
  http://127.0.0.1:3611 /tmp/react-note-proof
# then, with the session id the driver printed:
RESTART_OUT=/tmp/react-note-proof \
  bash apps/web/tests/fixture/react-note/restart-check.sh \
  "$(cat /tmp/react-note-fixture-current)" 3611 3612 <sessionId>
# cleanup: kill "$(cat <fixtureDir>/dsh.pid)" "$(cat <fixtureDir>/mock.pid)"
```

两个脚本在任何一项度量与其预期形状矛盾时以非零退出，并打印每项检查的 `summary`。

## 它逐层确立了什么

- **Host + 线上路径（真实）：** 笔记是一个带信封 `ignorable` 标记的 log-only 事件，
  不启动回合、不产生模型请求、不生成标题、不写 goal/retry/queue 记录，agent 保持
  空闲，inbox 为空，surface 不变。
- **Provider 请求体（真实）：** 笔记出现在下一回合被记录的请求中的指定索引处，且是
  该请求唯一的增量。
- **Compaction（真实）：** 一次覆盖笔记 seq 的 `/compact`，其摘要请求与持久化检查点
  都不含反应文本，而笔记在此之后仍能抵达模型。
- **重启（真实进程、同一构建、同一 home）：** 会话重新打开，笔记仍在。

此处未确立的是浏览器 transcript。它的字节一致性由
`packages/client/ui-conversation/tests/reaction-note-transcript.client.spec.ts` 钉住
（节点注册表不会匹配这类事件，因此什么都不会渲染），这比截图更强，但本夹具并不打开
Web UI。
