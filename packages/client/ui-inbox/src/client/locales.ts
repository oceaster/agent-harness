/**
 * `inbox` namespace dictionaries: the inbox region's copy. Product copy is
 * Chinese (docs/web-styling.md); English is the second dictionary.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.agents': '对话',
  'inbox.marker': '收件箱（原型）',
  'inbox.clear': '清空',
  'inbox.rail': '收件箱',
}

/** English dictionary. */
export const en: Record<keyof typeof zh, string> = {
  'section.agents': 'Conversations',
  'inbox.marker': 'Inbox (prototype)',
  'inbox.clear': 'Clear',
  'inbox.rail': 'Inbox',
}

/** Dictionary key union of this namespace. */
export type InboxKey = keyof typeof zh
