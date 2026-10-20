# 反应笔记探针夹具（spike，工单 5ef4e080）

[English](README.md) | 中文

无密钥、一次性的测量装置，回答一个问题：「后台笔记能否在不启动回合的前提下抵达
agent 的下一次运行？」**它不是产品源码，不是测试套件，也没有接入任何门禁。** 结论
与建议见 `/NOTE-ONLY-DO-NOT-TOUCH-PRODUCT-SOURCE/reaction-note-spike.md`。

它之所以是真实 harness 而不是桩：它启动的是真正构建出的
`apps/cli/lib/bin.js --profile web`，并使用隔离的 `DSH_HOME`；仅有的两处替换是
(a) provider 端点指向 `mock-llm.mjs`，(b) 追加触发器是一条 home 级 patch 行，挂载
`probe-plugin.mjs` —— 因为**仓库里不存在能追加任意 session 事件的 RPC**，这一点本身
就是结论的一部分。没有编辑任何产品文件。

## 文件

| 文件 | 作用 |
| --- | --- |
| `start-react-note-fixture.sh` | 启动夹具：隔离 home、home patch 行、mock provider、`dsh web`；打印夹具目录 |
| `mock-llm.mjs` | 兼容 OpenAI 的记录型 provider；回放一次文本生成，其 SSE 行逐字复制自 `packages/llm/llm-deepseek/tests/mock-server.ts`（`textEvents`）；把它看到的反应笔记回显进回复，好让摘要明显带上它 |
| `probe-plugin.mjs` | host cordis 插件：`POST /react-note-probe/append`（log-only 事件类型或 `user/message` 载体）、`GET /react-note-probe/observe`、`GET /react-note-probe/model-input` |
| `probe.mjs` | 驱动夹具：负向测量、下一回合请求转储、两种载体、compaction |
| `transcript-probe.mjs` | Chromium 证明：log-only 笔记不改变 transcript 任何内容，而 `user/message` 载体会 |
| `evidence.json` | 一次成功运行产生的转储（消息体已裁剪） |

## 运行方式

需要一个已构建的 worktree（`npm run build` —— 只跑 `build:lib:host` 会缺少 client
bundle 与 web dist，web profile 无法启动）。

```sh
bash packages/client/ui-conversation/tests/fixture/react-note/start-react-note-fixture.sh 3591 3592
# prints: up: /tmp/react-note-fixture.XXXXXX

MOCK_URL=http://127.0.0.1:3592 PROBE_CWD=/tmp/react-note-fixture.XXXXXX/workspace \
  node packages/client/ui-conversation/tests/fixture/react-note/probe.mjs \
  http://127.0.0.1:3591 /tmp/react-note-proof
# exits non-zero when a measurement contradicts its expected shape

node packages/client/ui-conversation/tests/fixture/react-note/transcript-probe.mjs \
  http://127.0.0.1:3591 <sessionId from the probe dump> /tmp/react-note-proof
```

用夹具目录里的 pid 文件清理（`dsh.pid`、`mock.pid`）。

## 这个夹具踩过的两个坑，值得保留

- 在输入框里键入 `/compact` **不是**命令提示：斜杠分发在客户端，所以
  `session.prompt` 带上 `/compact` 只是把这段文本发给模型。因此探针调用浏览器调用的
  那个 typert remote —— `POST /api/commands/execute`，载荷为
  `{ args: { agentId, line, images } }`，即具名参数，而不是位置数组。
- web profile 在 host 层禁用了 `compaction-basic` 与 `command-compact`；它们来自
  agent preset，所以探针用 `agentPreset: 'code'`（一个随包发布的 preset）创建会话，
  否则 `/compact` 什么也不做。

## 会话 id 为什么是带日期的而不是固定的

夹具 home 只有在你复用目录时才会比一次探针运行活得更久，而每次运行新建
`session.create` 才能让 transcript 与 compaction 区间保持诚实。
`transcript-probe.mjs` 把会话 id 作为参数传入，同样出于这个原因。
