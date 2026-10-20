// Hero chrome for the blank-draft phase of ConversationRoot: fish headline and
// glow backdrop. Pure presentation — the resident composer is NOT rendered here
// (it keeps its own stable tree position in ConversationRoot so the textarea
// survives the hero → composer flip); CSS positions it over this shell's glow
// area during the hero phase.
//
// The workspace row that used to live here is gone: choosing a workspace minted
// a blank session with the deployment default preset, and the inbox owns which
// conversation is open (see the package README, "the removed surfaces").

import { useId } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationSlotProps['t']

/**
 * The soft blue backdrop ellipse (figma 313:14109). Rendered by the hero
 * owner (ConversationRoot), not HeroShell, so it can center on the input
 * card; the owner's className supplies all positioning.
 * @param props.className - positioning class from the owner.
 * @returns the blurred-ellipse svg element.
 */
export function HeroGlow({ className }: { className?: string | undefined }) {
  // Stable filter id so multiple hero mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`
  return (
    <svg className={className} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
      <defs>
        <filter
          id={glowFilterId}
          x="0"
          y="0"
          width="1051"
          height="468"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      <g filter={`url(#${glowFilterId})`}>
        <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.08" />
      </g>
    </svg>
  )
}

/** Hero chrome props. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/**
 * Render the hero chrome (headline only; no glow, no composer — the glow is
 * the owner's {@link HeroGlow}).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ t, children }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          <span className={css.headlineText}>{t('hero.headline')}</span>
          <span className={css.previewBadge}>{t('hero.preview')}</span>
        </div>
        <div className={css.body}>
          {/* The resident composer (ConversationRoot's root-owned scrollport)
              is CSS-centered in that scroll body during hero — see
              ConversationRoot.module.css [data-phase='hero']. */}
        </div>
      </div>
      {children}
    </div>
  )
}
