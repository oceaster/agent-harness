/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` reads identically to `trigger.fallback` today and is
 * still a separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 *
 * `effort.heading` no longer paints anything: the dialog's "Thinking effort"
 * heading element was removed on 2026-10-24, and the key survives only as the
 * slider's accessible name (`aria-label`) — the one place a screen-reader user
 * hears what that control is. The dialog itself is named by `menu.effort`.
 * The words a fixed policy shows — `Off`, `Max`, `Dynamic`, a delegated level —
 * are deliberately NOT locale keys: they are the deployment's copy, published
 * per session beside the policy (see `EffortPolicy.word`), so both dictionaries
 * keep their shared key set unchanged.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'effort.aria': '选择推理强度，当前 {effort}',
  'effort.heading': '推理强度',
  'effort.loading': '正在加载推理强度…',
  'effort.error': '无法更新推理强度，请重试。',
  'effort.unavailable': '此助手不提供推理强度设置。',
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '选择模型',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'effort.providerDefault': 'Default',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'blocked.composer': '当前模型不可用，请先选择模型',
  'empty.efforts': '当前模型未提供推理等级。',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'effort.aria': 'Choose effort, current {effort}',
  'effort.heading': 'Thinking effort',
  'effort.loading': 'Loading effort levels…',
  'effort.error': 'Could not update effort. Try again.',
  'effort.unavailable': 'Effort is not configurable for this agent.',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'blocked.composer': 'This model is unavailable — select one to continue',
  'empty.efforts': 'This model provides no reasoning effort levels.',
} satisfies Record<ModelKey, string>
