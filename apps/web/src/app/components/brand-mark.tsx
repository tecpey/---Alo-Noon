import Image from 'next/image'

import { brandAssets } from '@alo-noon/design-tokens'

import { brandCopy } from '../../lib/storefront-content'

/**
 * The logo, in the two forms it is allowed to appear in.
 *
 * `lockup` is the mark with the Persian wordmark set beside it, for the top bar
 * and the footer. `mark` is the arch alone, for the app tile, the section
 * eyebrows and anywhere too small for the wordmark to be read — a shrunk
 * lockup is a lockup nobody can read, which is worse than no logo.
 *
 * On the action colour and on the dark footer the light artwork is used, since
 * the gradient version disappears into both.
 */
export function BrandMark({
  variant = 'lockup',
  tone = 'default',
  size = 44,
}: {
  variant?: 'lockup' | 'mark'
  tone?: 'default' | 'light'
  size?: number
}) {
  const source = tone === 'light' ? brandAssets.markLight : brandAssets.mark

  if (variant === 'mark') {
    return (
      <Image
        src={source}
        alt={brandCopy.nameFa}
        width={size}
        height={Math.round(size * 1.35)}
        priority
      />
    )
  }

  return (
    <span className="brand-lockup">
      <span className="brand-lockup__words">
        <span className="brand-lockup__name">{brandCopy.nameFa}</span>
        <span className="brand-lockup__tagline">{brandCopy.taglineFa}</span>
      </span>
      <Image
        src={source}
        alt=""
        width={size}
        height={Math.round(size * 1.35)}
        priority
        aria-hidden="true"
      />
    </span>
  )
}
