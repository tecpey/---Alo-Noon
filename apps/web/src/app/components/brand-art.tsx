/**
 * Vector ornament, all of it derived from the mark.
 *
 * The temptation with decoration is to reach for something pretty and generic —
 * a blob, a mesh gradient, a swoosh. None of it would mean anything here. Every
 * shape below is taken from the logo itself: the arch of the tandoor mouth, the
 * three curls of steam, the wheat the whole business starts from. Repeated
 * quietly across the page, they are what makes a long scroll feel like one shop
 * rather than a series of sections that happen to share a colour.
 *
 * All of it is `aria-hidden` and none of it carries information. Ornament that
 * a screen reader announces is noise, and ornament that a customer has to
 * understand is a diagram nobody labelled.
 */

/**
 * The arch, tiled at very low contrast behind a section.
 *
 * The first attempt at this was a bigger tile at a heavier stroke, and it read
 * as wallpaper — which is the exact failure this comment was already warning
 * about, written by someone who then went and shipped it. Small tile, hairline
 * stroke, and an opacity you have to look for: at the strength where the
 * pattern is legible, it has stopped being texture.
 */
export function ArchTexture({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="arch-tile" width="54" height="62" patternUnits="userSpaceOnUse">
          <path
            d="M11 58V24a16 16 0 0 1 32 0v34"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#arch-tile)" />
    </svg>
  )
}

/**
 * A drift of steam, closing a section heading.
 *
 * Two waves at different phases and opacities, so it reads as something rising
 * rather than as a decorative squiggle. Written to fit its own viewBox — the
 * first version's curves ran off the top of the box and rendered as two stray
 * chevrons, which is what happens when ornament is written without being
 * looked at.
 */
export function SteamRibbon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 18C10 18 10 8 18 8s8 10 16 10 8-10 16-10 8 10 16 10 8-10 16-10 8 10 16 10"
        opacity="0.8"
      />
      <path
        d="M2 25C10 25 10 15 18 15s8 10 16 10 8-10 16-10 8 10 16 10 8-10 16-10 8 10 16 10"
        opacity="0.4"
      />
    </svg>
  )
}

/**
 * An empty basket, for the state where there is nothing in it.
 *
 * Drawn rather than borrowed, and drawn as this brand's basket: the arch is in
 * the weave. An empty state is the screen a customer sees when the product has
 * given them nothing, and a stock illustration there says nobody thought about
 * that moment.
 */
/**
 * A drawn loaf, for a bread the shop has no photograph of.
 *
 * The alternative is a broken image frame or a grey rectangle, and both read as
 * a fault in the page rather than a gap in the shop's photography. This reads as
 * a placeholder on purpose: it is unmistakably a drawing, so nobody takes it for
 * a picture of what they are buying.
 *
 * It is decorative — the product's name is right beneath it in text — so it is
 * hidden from assistive technology rather than given a description that would
 * repeat the name.
 */
export function BreadPlaceholderArt({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 96"
      fill="none"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      <path
        d="M28 62c0-18 12-30 30-30h44c18 0 30 12 30 30 0 6-4 10-10 10H38c-6 0-10-4-10-10Z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        opacity="0.75"
      />
      <path
        d="M52 44c6-5 12-5 18 0M78 44c6-5 12-5 18 0"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.45"
      />
      <path
        d="M96 22c-4-2.8-4-5 0-7.8s4-5 0-7.8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.4"
      />
      <path
        d="M108 24c-4-2.8-4-5 0-7.8s4-5 0-7.8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.25"
      />
    </svg>
  )
}

export function EmptyBasketArt({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 128"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="80" cy="112" rx="52" ry="7" fill="currentColor" opacity="0.08" />
      <path
        d="M34 52h92l-9 50a10 10 0 0 1-10 8H53a10 10 0 0 1-10-8Z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M34 52h92" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M58 52V38a22 22 0 0 1 44 0v14"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M64 68l4 34M96 68l-4 34M80 68v34"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.4"
      />
      <path
        d="M112 22c-5-3.5-5-6.3 0-9.8s5-6.3 0-9.8"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M124 26c-5-3.5-5-6.3 0-9.8s5-6.3 0-9.8"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.35"
      />
    </svg>
  )
}
