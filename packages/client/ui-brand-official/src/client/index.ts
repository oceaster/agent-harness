/** No occupants: company branding (the fish/whale mark) is removed in this fork. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** No services are required once the brand occupants are gone. */
export const inject = [] as const

/** No-op apply: this fork ships no company branding. */
export function apply(_ctx: ClientContext): void {}
