# Agent Note: 品牌化的空白会话

Status: implemented

[English](2026-10-20-branded-empty-conversation.md) | 中文

## Problem

打开一个没有任何消息的会话时，显示的是 harness 自带的空状态：一句 "Into the Unknown" 标题、一个 "Preview" 徽章，以及竖直居中于列中央的输入卡片。家族在相邻的另一个状态——完全没有选中会话时——已经有品牌化的欢迎页，于是打开一个智能体后第一眼看到的却是别人的空状态，而首条消息会把输入框从列中央挪到列底部。

## Decision

空白会话即普通活跃布局，只是主体里放着家族标记。会话主体承载与欢迎页相同的那套图案（`HeroGlow` 椭圆，加上被遮罩成柔和渐变的品牌标），居中于一个以 `flex` 填满空间、带有 `data-testid="conversation-empty"` 的容器中；输入框保留其停靠的 sticky seat、卡片几何与常规 placeholder，因此发送首条消息既不会移动也不会改变它的尺寸，而在对话记录出现时标记消失。输入栏不再有居中变体：空白会话与活跃会话共用一套几何。

空状态标题 chrome 是删除而非隐藏。`HeroShell` 与 `HeroShell.module.css` 已移除，`hero.headline` / `hero.preview` / `placeholder.hero` 三个 locale 键在两种语言中均已移除，根组件只报告 `active` 与 `settling`。共用的背景椭圆移到 `HeroGlow.tsx`，那也是唯一仍有调用者的导出。

`settling` 保持不变：当空白会话的打开仍在加载、且会话列表摘要尚未证明它为空时，输入框 seat 继续隐藏——如今图案也一同隐藏，因为先闪现图案再让位给对话记录，与当初隐藏输入框所防的是同一种"整页重载"观感。摘要已证明为空的会话跳过 settling，立即显示图案。

## Alternatives considered

**保留 hero 阶段并重新修饰它。** 否决：该阶段的存在只为居中卡片和标题，而两者都已移除。保留它意味着把 `data-phase='hero'`、居中堆栈与 hero 输入框变体留作死状态，让此后每次布局改动都要为它们做判断。

**只隐藏标题、保留居中卡片。** 否决，因为那恰好保留了用户报告的那个缺陷：首条消息时输入框仍会跳到列底部。

**把欢迎页复用为两种状态共用的一个组件。** 否决：欢迎页拥有页脚与提示语，并且没有输入框，共用就意味着每个元素都要加一个模式开关。真正的共用部分是图案，而抽取的正是它。

## Consequences

装配后的界面不再有 harness 自带的空状态文案，因此 `apps/web/tests` 中的 hero 锚点（`Into the Unknown`、hero placeholder、`data-phase="hero"`）改为该 placeholder 的 test id 与常规 placeholder；两个 lifecycle-chrome 基准文件失去了标题行，并重新记录了输入框 placeholder。`EmptyHero.tsx` 重命名为 `HeroGlow.tsx`。`conversation.hero.agentPreset` slot 尽管没有任何界面渲染它，仍保留原名字，因为空白会话上同样没有注册任何 chip。

该 placeholder 不含文本且带 `aria-hidden`，因此空白会话自身没有无障碍描述；唯一的提示是输入框的 placeholder，而活跃会话提供的也正是这个。

## Verification

`packages/client/ui-conversation` 的 vitest 固定了以下行为：空白会话中 placeholder 存在、在 settling 期间与首条消息之后不存在、placeholder 与输入框 seat 在 `[data-conversation-scroll]` 内的兄弟顺序、`active` 阶段，以及常规的输入框 placeholder。移除该源码改动会使这些断言失败。
