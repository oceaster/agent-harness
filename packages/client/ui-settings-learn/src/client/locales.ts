/**
 * `settings.learn` namespace dictionaries: the tab's title, its labels, and the
 * copy for the four states. English is the household's product copy and the
 * key-set source of truth; Chinese ships as the second dictionary because the
 * harness's other surfaces carry both.
 *
 * NOTHING HERE NAMES AN AGENT, and nothing here paraphrases a guide. Every
 * agent name, summary, section title and section body arrives in the payload
 * from the server — the plugin would otherwise be a second, silently drifting
 * copy of the guides, and a hardcoded section title would mislabel a guide whose
 * sections changed on the server. What is here is only what the browser owns:
 * the tab label, the state lines, and the vocabulary for failure codes.
 */

/** English dictionary (the key-set source of truth). */
export const en = {
  'nav': 'Learn More',
  'intro': 'How each of your agents works, what it will not do, and how to get the best out of it.',
  'person': 'Guides for {name}',

  'state.loading': 'Loading the guides…',
  'state.retry': 'Try again',
  'state.error': 'The guides could not load',
  'state.detail': 'The server said:',
  'state.empty.title': 'No guides for this profile',
  'state.empty.body': 'This profile has no agents in this deployment, so there is nothing to explain yet.',
  'state.refused.title': 'The agent guides are not available to this profile',
  'state.refused.body': 'Ask a household admin if you expected to see them.',

  'agent.disabled': 'Disabled',

  'error.unauthenticated': 'You are not signed in with a household profile.',
  'error.forbidden': 'This profile may not use the agent harness.',
  'error.conflict': 'Select a profile first.',
  'error.hostUnavailable': 'The agent harness refused the request.',
  'error.serverError': 'The server could not serve the agent guides.',
  'error.unavailable': 'The agent harness is restarting. Try again in a moment.',
  'error.notFound': 'This server does not serve the agent guides yet.',
  'error.timeout': 'The server did not answer in time.',
  'error.transport': 'The server could not be reached.',
  'error.malformed': 'The server answered something this page could not read.',
  'error.unexpected': 'The server refused the request.',
} as const

/** Dictionary key union of this namespace. */
export type LearnKey = keyof typeof en

/** Shipped Chinese dictionary (same key set). */
export const zh: Record<LearnKey, string> = {
  'nav': '了解更多',
  'intro': '每个助手如何工作、不会做什么，以及怎样与它配合得最好。',
  'person': '适用于 {name} 的说明',

  'state.loading': '正在加载说明…',
  'state.retry': '重试',
  'state.error': '说明加载失败',
  'state.detail': '服务器返回：',
  'state.empty.title': '这个档案没有可用的说明',
  'state.empty.body': '这个档案在当前部署中还没有分配任何助手，因此暂时没有可介绍的内容。',
  'state.refused.title': '这个档案无法查看助手说明',
  'state.refused.body': '如果你预期在这里看到说明，请联系家庭管理员。',

  'agent.disabled': '已禁用',

  'error.unauthenticated': '你没有使用家庭档案登录。',
  'error.forbidden': '这个档案无权使用 agent harness。',
  'error.conflict': '请先选择一个档案。',
  'error.hostUnavailable': 'agent harness 拒绝了该请求。',
  'error.serverError': '服务器无法提供助手说明。',
  'error.unavailable': 'agent harness 正在重启，请稍后再试。',
  'error.notFound': '这台服务器还没有提供助手说明接口。',
  'error.timeout': '服务器没有及时响应。',
  'error.transport': '无法连接服务器。',
  'error.malformed': '服务器返回了本页面无法解析的内容。',
  'error.unexpected': '服务器拒绝了该请求。',
}
