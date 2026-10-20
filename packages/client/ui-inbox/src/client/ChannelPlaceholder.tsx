/**
 * Household mark for a loaded agent channel that has no messages.
 *
 * Deliberately local to this package. The conversation welcome screen renders
 * the same art from ui-conversation's skeleton (`HeroGlow` + a masked div), and
 * this copy is NOT hoisted into an upstream package such as ui-primitives: the
 * fork-only `ec-logo-2-outline` asset and its gradient are household branding,
 * while ui-inbox and ui-conversation are independent client packages that must
 * not import each other's internals. Two small copies of one decorative mark
 * are cheaper than a new shared package both must depend on, and the
 * duplication is the accepted price of that boundary. Keep them in step by
 * hand (`.channelEmpty*` in InboxPanel.module.css copies the welcome screen's
 * proportions, gradient and opacity verbatim) rather than by import.
 *
 * The blur filter and the ellipse fill below are the same asset values, not
 * theme colours: the art is fixed branding, so the literals travel with it.
 */

import { useId } from 'react'
import css from './InboxPanel.module.css'

/**
 * Render the glow ellipse plus the masked household mark, centered and
 * decorative: the channel page keeps its own accessible name, so the whole
 * tree is hidden from assistive technology.
 * @returns the empty-channel art wrapped in its centering box.
 */
export function ChannelPlaceholder() {
  // Stable per-instance filter id: two channels mounted at once (or a fast
  // remount) must not collide in the DOM, and a fixed id would leak between
  // them. `useId` also survives SSR/hydration, unlike a module counter.
  const glowFilterId = `channel-glow-${useId().replace(/:/g, '')}`
  return <div className={css.channelEmpty} data-testid="agent-channel-empty" aria-hidden="true">
    {/* The glow below is the same asset ui-conversation's HeroGlow draws. The
        copy is deliberate (see the file header), so it is declared to the
        duplication gate instead of landing as a new clone report. */}
    {/* jscpd:ignore-start */}
    <svg className={css.channelEmptyGlow} viewBox="0 0 1051 468" fill="none">
      <defs>
        <filter id={glowFilterId} x="0" y="0" width="1051" height="468" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      <g filter={`url(#${glowFilterId})`}>
        <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.08" />
      </g>
    </svg>
    {/* jscpd:ignore-end */}
    <div className={css.channelEmptyMark} />
  </div>
}
