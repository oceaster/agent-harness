# Agent Note: Provider-scoped env credentials for pi-ai routes

Status: implemented

[English](2026-10-18-pi-ai-provider-scoped-env-credentials.md) | 中文

## Problem

pi-ai 适配器过去只能给一条路由一个机密：`apiKeyEnv` 把引用解析进 pi-ai 的 `apiKey` 流选项，而 pi-ai 把它当作 bearer token。Amazon Bedrock 用访问密钥 ID、机密访问密钥和区域做 SigV4 签名，因此 Bedrock 路由根本无法用 harness 的凭据存储完成认证。它当时的选择只有两个：把 AWS 环境变量导出给整个进程——于是该主机上的每条路由都以同一身份认证——或者让这条路由不可用。

## Decision

`PiAiProviderProfile` 新增 `env` 与 `envCredentials`：前者是提供方作用域的明文值（例如 `AWS_REGION`），后者是以所填充的环境变量名为键的凭据*引用*。`resolveProfiles` 校验这两个 dict 并脱离原对象复制存活项：键必须是 POSIX 环境变量名，明文值不得为空，引用必须是合法的凭据引用，两个 dict 声明同一个名字会被拒绝而不是解析两次。每一处失败都点名路由与键，因此产生它的 settings 写入会被拒绝而非存储。

解析后的 profile 只保留引用。每个请求都通过与 `apiKeyEnv` 相同的 seam——`ctx.credentials`，否则 `launchEnvironmentOf(ctx)`——解析 `envCredentials` 的每一项，解析不出则以 `LlmError('MISSING_CREDENTIAL')` 失败，点名路由、名字与引用。缺席与空值都不会被交出：pi-ai 的 `getProviderEnvValue` 对两者都回落到 `process.env`，于是点名了引用的路由会悄悄用宿主恰好持有的某个环境 AWS 身份完成签名。

`adapter.ts` 先把 `profile.env` 铺底、再把解析出的凭据覆盖上去，合为 `profileOptions()` 在 apiKey、reasoning 与 timeout 旁构建的那一个 `env` 选项；两者都未声明的路由完全不发送 `env`。pi-ai 的 `Models` 会用该选项覆盖其 auth context，Bedrock 提供方自己的解析正是在那里读取 AWS 变量，签名则由其模块完成。

与 `assertUsableApiKey` 中的 API 密钥不同，环境值既不去空白也不校验标头安全性：读取它们的是提供方 SDK 而不是 HTTP 标头，且 AWS 机密访问密钥合法地包含 `+`、`/` 和 `=`。

`ProviderSpec.namesCredential` 仍只由 `apiKeyEnv` 决定。因此靠环境变量认证的 catalog 路由会保留已安装提供方自带的认证方式，而不会获得 harness 的 bearer-token 方式——SigV4 协议从不需要后者。

## Alternatives considered

**用一个 `env` dict 承载可能为引用的值**（如 `${REF}` 标记，或把看起来像变量名的字符串都解析掉）：解析将不得不猜测一个字符串是字面量还是引用，而恰好撞上该语法的字面量会被静默当作另一种。

**把凭据集经 `apiKey` 传入**：pi-ai 的 Bedrock 认证会把 `key` 读作 Bedrock bearer token，那是另一种凭据，于是 SigV4 路由会以一个无效 token 而非已签名的身份认证。

**在 `supportedProtocols()` 中加入 `bedrock-converse-stream`**：SigV4 签名位于 pi-ai 的 Bedrock 提供方模块中，它通过独立入口加载自己的 Smithy 栈，本包无法重建，因此协议表保持狭窄，只有 catalog 的 Bedrock 路由受益。

**在构造时把引用解析进 profile**：解析后的 profile 会返回给配置界面与 RPC 调用方，值会落入对设置可见的载荷，且轮换需要重新加载。

## Consequences

轮换不再有代价：改变的凭据在下个请求即生效、无需重启，而一条路由的明文值与引用承载了任何单一 API 密钥都无法表达的提供方配置。

任何机密值都不会进入日志、错误消息、settings 文档或解析后的 profile——只有引用，那也是失败消息点名的东西。

两者都未声明的路由发送的选项与这两个字段存在之前完全一致，因此 deepseek 路由与仅用 `apiKeyEnv` 的路由不受影响。

延后：配置界面还没有 env 编辑器——Models 页面尚未渲染这两个 dict——也没有任何东西按提供方已知的变量集合校验名字、检查 SigV4 密钥对是否完整，或把这份提供方作用域环境供给端点探测。

`tests/env-credentials.spec.ts` 钉住 schema 拒绝、两条解析 seam、在录制型 pi-ai 提供方上观察到的合并选项、每个请求对轮换值的重解析、拒绝用环境凭据签名，以及机密不出现在解析后 profile 与失败消息中。没有发起真实 Bedrock 请求：那需要真实 AWS 凭据，而已装配的证据止于 pi-ai 收到的选项。
