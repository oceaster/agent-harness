# dsh-client-ui-agent-preset

[English](README.md) | 中文

只有一个表层：会话页头中一个只读标签，标明本会话运行的 [preset](../../preset/agent-presets/README.md)。

## 为什么本包只剩这个标签

会话的 preset 在创建时即固定——宿主拒绝以不同 preset 接管已存在的会话，因为该会话的历史是在最初那份 preset 的工具下产生的。在这里放控件等于承诺一次宿主会直接拒绝的切换，因此该表层只报告正在运行什么。

对话使用哪个 Agent 在开始之前就已决定：某个人的某个 Agent，其收件箱行会解析出这个会话，而部署默认的 preset 来自组装配置。浏览器中没有任何东西选择 preset、写入默认值或管理名单，所以本包此前提供的设置行、新建会话 chip 与名单管理分区都已被删除。

## 它读取什么

一次 `agentPreset.list` 调用即可拿到显示文案，且只在该会话确实记录了 preset 之后才发出：不组装任何 preset 的部署不该为每个页头付一次名单读取的代价。标签从会话自身的摘要里取出 preset id，再用那份名单解析名称与描述；在名单返回之前，以及名单解析不到的 preset，显示的都是 id。

preset 文件只发布一份未本地化的 `name` 与 `description`，Web 对每个 `user` 行和未知 `system` 行都用它。对于四个内置 id（`standard`、`code`、`minimal`、`cordis`），只有当名单把该行标记为 `system` 时，Web 才从当前语言解析这两个字段；同名但属于 `user` 的 preset 保留其文件元数据。

转发的 `agent-preset/selected` owner 事件会把在另一个标签页提交的 preset 折进本标签所渲染的会话摘要；发起方标签页可能已经应用过 RPC 回执，这次合并是幂等的。

## 它挂在哪里

注册的目标是 `conversation.session.header.mode`，该座位由 [`dsh-client-ui-conversation`](../ui-conversation/README.md) 声明。随附的会话骨架渲染页头的 actions 与 utilities，但不渲染这个座位，因此在当前 Web 组装中本标签会注册但不可见。它保留为该座位的身份标签，而不是装饰。

## 模型体验

无。本标签只读取一份名单并渲染文本；会话组装向模型呈现什么，由 [`dsh-agent-presets`](../../preset/agent-presets/README.md) 负责。

#### KV Cache 影响

无影响；此处没有任何内容到达请求。

## 已知限制与后续工作

- **没有元数据的 preset 以 id 呈现** —— 显示文案是可选的，未命名的 preset 回退到它的目录名，而不是编造一个名字。
- **名单读取失败时显示 id** —— 用被拒绝或过期的读取去命名，会展示宿主已不再确认的文案，因此标签退回到会话记录的 id。
- **该座位目前不会被渲染** —— 骨架中没有 `conversation.session.header.mode` 的挂载点；日后某个页头挂载它时，无需额外工作即可得到本标签。
