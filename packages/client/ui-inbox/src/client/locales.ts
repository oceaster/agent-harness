/**
 * `inbox` namespace dictionaries. English is the household's product copy and
 * the key-set source of truth; Chinese ships as the second dictionary because
 * the harness's other surfaces carry both.
 *
 * Nothing here names an agent: the only place an agent's name appears is the
 * `{name}` template param, filled from the API payload. A hardcoded roster or
 * a per-agent colour would silently hand one person another person's row.
 */

/** English dictionary (the key-set source of truth). */
export const en = {
  'section.agents': 'Inbox',
  'panel.collapse': 'Collapse sidebar',
  'channel.section': 'Agent Channels',
  'channel.title': 'Agent Channel',
  'channel.readOnly': 'Read-only channel',
  'channel.clearTitle': 'Clear your channel {name}?',
  'channel.none': 'No shared agent channels.',
  'channel.body': 'Your agents’ shared channel. Messages wake an idle agent, queue during work, or interrupt when marked high priority.',
  'channel.refresh': 'Refresh channel',
  'channel.loading': 'Loading messages…',
  'channel.high': 'High priority',
  'channel.clear': 'Clear',
  'channel.clearBody': 'Clear your channel history and undelivered notifications? Messages already accepted by an agent remain in its conversation.',
  'channel.confirmClear': 'Clear channel',

  'panel.refresh': 'Refresh',
  'panel.rail.label': 'Your conversations',

  'row.disabled': 'Disabled',
  'presence.online': 'Online',
  'presence.offline': 'Offline',
  'presence.unread': 'Unread response',
  'presence.error': 'Stopped: fatal error',
  'row.fresh': 'No conversation yet',
  'row.blank': 'No messages yet',
  // One working verb per agent, in the four shapes the row draws: the dot's
  // bare label, the state line, and the state line's two count forms. Each
  // shape is a whole sentence rather than a verb word spliced onto a suffix,
  // so a language whose count wording differs can translate it.
  'verb.working.dot': 'Working',
  'verb.working.line': 'Working...',
  'verb.working.count': 'Working... ({n})',
  'verb.working.pair': 'Working... ({working}/{total})',
  'verb.chatting.dot': 'Chatting',
  'verb.chatting.line': 'Chatting...',
  'verb.chatting.count': 'Chatting... ({n})',
  'verb.chatting.pair': 'Chatting... ({working}/{total})',
  'verb.thinking.dot': 'Thinking',
  'verb.thinking.line': 'Thinking...',
  'verb.thinking.count': 'Thinking... ({n})',
  'verb.thinking.pair': 'Thinking... ({working}/{total})',
  'row.open': 'Open your conversation with {name}',
  'row.opening': 'Opening…',
  'row.clearing': 'Clearing…',
  'row.menu': 'More actions for {name}',
  'row.clear': 'Clear',

  'time.now': 'now',
  'time.min': '{n}m ago',
  'time.hour': '{n}h ago',
  'time.day': '{n}d ago',

  'dialog.title': 'Clear your conversation with {name}?',
  'dialog.body': 'The messages are permanently deleted. This cannot be undone.',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Clear conversation',
  'dialog.close': 'Close',

  'state.loading': 'Loading conversations…',
  'state.empty.title': 'No agents yet',
  'state.empty.body': 'This profile has no agents in this deployment yet.',
  'state.refused.title': 'The Agent Harness is not available to this profile',
  'state.refused.body': 'Ask a household admin if you expected to see conversations here.',
  'state.error': 'Conversations could not load',
  'state.retry': 'Try again',

  'notice.clear-refused': 'The conversation was not cleared. It still exists.',
  'notice.session-not-listed': 'The conversation opened, but this page could not show it yet.',

  'error.unauthenticated': 'You are not signed in with a household profile.',
  'error.forbidden': 'This profile may not use that agent.',
  'error.conflict': 'That agent already has a conversation composed differently, so it cannot be opened.',
  'error.unavailable': 'The harness is restarting. Try again in a moment.',
  'error.hostUnavailable': 'That conversation could not be opened. Try again in a moment.',
  'error.notFound': 'This server does not serve the inbox API.',
  'error.timeout': 'The server did not answer in time.',
  'error.transport': 'The server could not be reached.',
  'error.malformed': 'The server answered something this page could not read.',
  'error.unexpected': 'The server refused the request.',
} as const

/** Dictionary key union of this namespace. */
export type InboxKey = keyof typeof en

/** Shipped Chinese dictionary (same key set). */
export const zh: Record<InboxKey, string> = {
  'section.agents': '收件箱',
  'panel.collapse': '收起侧边栏',
  'channel.section': '助手频道',
  'channel.title': '助手频道',
  'channel.readOnly': '只读频道',
  'channel.clearTitle': '清空你的频道 {name}？',
  'channel.none': '没有共享助手频道。',
  'channel.body': '助手共享的频道。消息会唤醒空闲助手，在工作时排队，高优先级消息会中断当前工作。',
  'channel.refresh': '刷新频道',
  'channel.loading': '正在加载消息…',
  'channel.high': '高优先级',
  'channel.clear': '清空',
  'channel.clearBody': '清空你的频道历史和未发送的通知？助手已经接收的消息将保留在其对话中。',
  'channel.confirmClear': '清空频道',

  'panel.refresh': '刷新',
  'panel.rail.label': '你的对话',

  'row.disabled': '已禁用',
  'presence.online': '在线',
  'presence.offline': '离线',
  'presence.unread': '未读回复',
  'presence.error': '已停止：致命错误',
  'row.fresh': '尚无对话',
  'row.blank': '还没有消息',
  'verb.working.dot': '正在工作',
  'verb.working.line': '正在工作...',
  'verb.working.count': '正在工作... ({n})',
  'verb.working.pair': '正在工作... ({working}/{total})',
  'verb.chatting.dot': '聊天中',
  'verb.chatting.line': '聊天中...',
  'verb.chatting.count': '聊天中... ({n})',
  'verb.chatting.pair': '聊天中... ({working}/{total})',
  'verb.thinking.dot': '思考中',
  'verb.thinking.line': '思考中...',
  'verb.thinking.count': '思考中... ({n})',
  'verb.thinking.pair': '思考中... ({working}/{total})',
  'row.open': '打开与 {name} 的对话',
  'row.opening': '正在打开…',
  'row.clearing': '正在清空…',
  'row.menu': '{name} 的更多操作',
  'row.clear': '清空',

  'time.now': '刚刚',
  'time.min': '{n} 分钟前',
  'time.hour': '{n} 小时前',
  'time.day': '{n} 天前',

  'dialog.title': '清空与 {name} 的对话？',
  'dialog.body': '消息将被永久删除，且无法恢复。',
  'dialog.cancel': '取消',
  'dialog.confirm': '清空对话',
  'dialog.close': '关闭',

  'state.loading': '正在加载对话…',
  'state.empty.title': '还没有可用的助手',
  'state.empty.body': '这个档案在当前部署中还没有分配任何助手。',
  'state.refused.title': '这个档案无法使用 Agent Harness',
  'state.refused.body': '如果你预期在这里看到对话，请联系家庭管理员。',
  'state.error': '对话加载失败',
  'state.retry': '重试',

  'notice.clear-refused': '对话没有被清空，它仍然存在。',
  'notice.session-not-listed': '对话已打开，但这个页面暂时无法显示它。',

  'error.unauthenticated': '你没有使用家庭档案登录。',
  'error.forbidden': '这个档案无权使用该助手。',
  'error.conflict': '该助手已有一个以不同配置建立的对话，无法打开。',
  'error.unavailable': 'harness 正在重启，请稍后再试。',
  'error.hostUnavailable': '无法打开该对话，请稍后再试。',
  'error.notFound': '这台服务器没有提供收件箱接口。',
  'error.timeout': '服务器没有及时响应。',
  'error.transport': '无法连接服务器。',
  'error.malformed': '服务器返回了本页面无法解析的内容。',
  'error.unexpected': '服务器拒绝了该请求。',
}
