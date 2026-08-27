/**
 * The Alo Noon design system.
 *
 * Every value here was read off the brand artwork rather than chosen: the
 * oranges are sampled from the logo's own gradient, the browns from its
 * wordmark, the papers from the interface it sits on. That matters because a
 * palette invented alongside a logo drifts from it — the two look related for
 * one screen and unrelated by the tenth.
 *
 * The identity is warm and printed, not digital: paper rather than white,
 * brown ink rather than black, and one orange that means "act" and is spent
 * nowhere else. Persian-first and right-to-left throughout, so type sizes are
 * set for Vazirmatn's tall Arabic-script forms rather than for Latin.
 *
 * Shared by the web storefront, the admin panel and both mobile apps. There is
 * no second copy of these numbers anywhere: the web emits them as CSS custom
 * properties from this file (see `cssVariables`), and React Native reads them
 * directly.
 */

/**
 * The logo's gradient, sampled along the arch from its top-left to its foot.
 *
 * Kept as its own scale rather than folded into `primary`, because the mark's
 * tan-to-ember run belongs to the mark. Painting a button in it would make the
 * logo one more decorated surface instead of the one thing on the page that is.
 */
export const brand = {
  /** Where the arch begins: a wheat-fired clay. */
  tan: '#C08452',
  /** The turn from clay to fire. */
  amber: '#E4761F',
  /** The mark's own orange — the head, the steam, the app tile. */
  ember: '#ED8732',
  /** The foot of the arch, deepest point of the gradient. */
  fired: '#DC652B',
  /** The wordmark's ink. */
  ink: '#261F17',
} as const

export const colors = {
  /**
   * The action colour.
   *
   * 500 is the mark's orange; 600 is the deeper one every button and price
   * badge in the interface uses. They are deliberately close and deliberately
   * distinct: the brand appears, the action commands.
   */
  primary: {
    50: '#FDF4EA',
    100: '#FAE6D2',
    200: '#F4CDA9',
    300: '#EFAE79',
    400: '#EE9A50',
    500: '#ED8732',
    600: '#E4520D',
    700: '#C24309',
    800: '#993507',
    900: '#722705',
    950: '#3A1608',
  },
  /**
   * Warm neutrals, tinted brown rather than grey.
   *
   * A grey next to this orange reads as dirty, and a pure white next to these
   * papers reads as a hole in the page. 100 is the app's surface, 200 its
   * hairlines, 600 its secondary text, 900 its ink — all sampled.
   */
  neutral: {
    50: '#FBF6EF',
    100: '#F5EBDF',
    200: '#EBDECD',
    300: '#DCC9B0',
    400: '#BFA98C',
    500: '#9C8A72',
    600: '#867765',
    700: '#6B5C48',
    800: '#4A3B2A',
    900: '#261F17',
    950: '#160F09',
  },
  /**
   * Semantic colours, warmed to sit in this palette.
   *
   * The stock greens and reds of a default palette are cold enough beside these
   * papers to look like they came from another product.
   */
  success: '#3F7D3A',
  warning: '#B5820F',
  error: '#C0392B',
  info: '#3A6A8C',
  // Named surfaces, kept for readability at the call site.
  /** Raised cards, the top bar, the tab bar. */
  cream: '#FBF3E8',
  /** The application's own ground. */
  paper: '#F5EBDF',
  /** Behind the application, and every hairline drawn on it. */
  sand: '#EBDECD',
  wheat: '#C08452',
  crust: '#8B5A2B',
  fresh: '#3F7D3A',
} as const

/**
 * Surfaces and ink, named by role rather than by shade.
 *
 * A component asking for `surface.card` keeps working when the card colour is
 * retuned; one asking for `neutral[50]` has to be found and edited.
 */
export const surface = {
  /** Outside the app frame. */
  page: colors.sand,
  /** The app's own ground. */
  base: colors.paper,
  /** Cards, bars, anything lifted off the ground. */
  card: colors.cream,
  /** Inputs and quiet wells sunk into a card. */
  sunken: '#F1E4D3',
  /** Footers and any surface that carries light type. */
  inverse: colors.neutral[900],
} as const

export const ink = {
  /** Headlines and anything that must be read first. */
  strong: colors.neutral[900],
  /** Body copy. */
  base: colors.neutral[800],
  /** Captions, secondary lines, the second row of a card. */
  muted: colors.neutral[600],
  /** Placeholders, disabled text. */
  faint: colors.neutral[500],
  /** On the action colour and on inverse surfaces. */
  onAction: '#FFF9F2',
  /** Prices, links, anything that is itself the action. */
  action: colors.primary[600],
} as const

export const line = {
  /** Hairlines between rows and around cards. */
  subtle: colors.sand,
  /** Input borders and dividers that must be seen. */
  base: colors.neutral[300],
  /** A focused or selected edge. */
  strong: colors.primary[600],
} as const

/**
 * The mark's gradient, and the two washes the interface uses behind imagery.
 *
 * `brandArc` runs the way the logo does — top-left to bottom-right — so a
 * surface painted with it and the mark on top read as one object.
 */
export const gradients = {
  brandArc: `linear-gradient(155deg, ${brand.tan} 0%, ${brand.amber} 55%, ${brand.fired} 100%)`,
  action: `linear-gradient(180deg, ${colors.primary[600]} 0%, ${colors.primary[700]} 100%)`,
  /** Fades a photograph into the page so it has no visible edge. */
  heroVeil: `linear-gradient(90deg, ${colors.paper} 12%, rgba(245,235,223,0.72) 42%, rgba(245,235,223,0) 78%)`,
  /** Same idea, downward, for a photograph above stacked content on a phone. */
  heroVeilVertical: `linear-gradient(180deg, rgba(245,235,223,0) 30%, rgba(245,235,223,0.86) 72%, ${colors.paper} 100%)`,
} as const

/**
 * Blends two hex colours.
 *
 * CSS can do this itself with `color-mix`, but React Native cannot, and a
 * state tint computed one way on the web and hand-picked another way on a phone
 * is two greens that drift apart the first time either is retuned. So it is
 * computed once, here, for all three surfaces.
 */
export function mix(from: string, to: string, weight: number): string {
  const clamped = Math.min(1, Math.max(0, weight))
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16)
  const blend = (at: number) =>
    Math.round(channel(from, at) * (1 - clamped) + channel(to, at) * clamped)
      .toString(16)
      .padStart(2, '0')
  return `#${blend(1)}${blend(3)}${blend(5)}`.toUpperCase()
}

/**
 * Backgrounds, borders and text for the four states, each mixed into the card
 * surface rather than picked.
 *
 * Picked tints are how a palette ends up with a warm green foreground on a cold
 * green background: the two were chosen months apart. Mixed ones cannot drift —
 * retune `success` and its background follows.
 */
function stateTint(base: string) {
  return {
    surface: mix(colors.cream, base, 0.1),
    border: mix(colors.cream, base, 0.32),
    ink: mix(base, colors.neutral[950], 0.35),
  } as const
}

export const tint = {
  success: stateTint(colors.success),
  warning: stateTint(colors.warning),
  error: stateTint(colors.error),
  info: stateTint(colors.info),
} as const

/**
 * Glass, and where it is allowed.
 *
 * Glass is a material for things that float above other things. Used that way
 * it tells a real story — the bar you are reading through is not part of the
 * page, it is over it — and the blur carries the colour of whatever passes
 * underneath, which on a page of bread photographs is warm and alive.
 *
 * Used on a flat card sitting on flat paper it says nothing, costs a compositor
 * layer, and makes text harder to read for the sake of a texture nobody asked
 * about. So there are exactly three glasses here and each names its job: the
 * bar pinned to the top, the panel that sits on a photograph, and the sheet
 * that rises over the whole page. Anything else gets a solid surface.
 *
 * Every one carries a lit top edge and a hairline. Real glass has an edge; a
 * translucent rectangle without one reads as a rendering bug.
 */
export const glass = {
  /** The pinned top bar. Light enough to read type through at speed. */
  bar: {
    background: 'rgba(251, 243, 232, 0.72)',
    backdropFilter: 'blur(20px) saturate(1.7)',
    border: 'rgba(255, 255, 255, 0.55)',
    highlight: 'rgba(255, 255, 255, 0.65)',
    shadow: '0 8px 28px -14px rgb(38 31 23 / 0.28)',
    /** When the browser has no backdrop-filter, and on the first paint. */
    fallback: '#FAF1E5',
  },
  /** A panel laid over imagery — the delivery bar on the hero photograph. */
  panel: {
    background: 'rgba(251, 243, 232, 0.62)',
    backdropFilter: 'blur(26px) saturate(1.8)',
    border: 'rgba(255, 255, 255, 0.5)',
    highlight: 'rgba(255, 255, 255, 0.55)',
    shadow: '0 18px 44px -24px rgb(38 31 23 / 0.42)',
    fallback: '#F8EDDF',
  },
  /** A sheet that rises over everything: dialogs, the basket, a filter drawer. */
  sheet: {
    background: 'rgba(248, 238, 226, 0.86)',
    backdropFilter: 'blur(34px) saturate(1.5)',
    border: 'rgba(255, 255, 255, 0.6)',
    highlight: 'rgba(255, 255, 255, 0.7)',
    shadow: '0 32px 70px -30px rgb(38 31 23 / 0.5)',
    fallback: '#F7EDE0',
  },
} as const

/**
 * The elevation ladder, in the order things stack.
 *
 * Named by what lives there rather than by number, because "z-index: 60" tells
 * the next person nothing about whether their tooltip should be above it.
 */
export const elevation = {
  flat: 0,
  raised: 1,
  sticky: 10,
  overlay: 40,
  modal: 60,
  toast: 80,
} as const

export const spacing = {
  0: '0',
  0.5: '0.125rem',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
  32: '8rem',
} as const

export const typography = {
  /**
   * Vazirmatn, self-hosted.
   *
   * Not loaded from a font CDN: this is a service for Iranian customers, and a
   * font that fails to arrive leaves the whole interface in a fallback that was
   * never designed for. The Arabic subset is what ships; Latin falls back,
   * which is what the fallback stack is for.
   */
  fontFamily: {
    body: ['Vazirmatn', 'Tahoma', 'Arial', 'sans-serif'],
    heading: ['Vazirmatn', 'Tahoma', 'Arial', 'sans-serif'],
    mono: ['Consolas', 'Monaco', 'monospace'],
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
    '4xl': '2.25rem',
    '5xl': '3rem',
    '6xl': '3.75rem',
  },
  fontWeight: {
    normal: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
    /** The headline weight. Vazirmatn's 800 is what the artwork sets. */
    black: '800',
  },
  /**
   * Persian script sits taller than Latin and its descenders are longer, so
   * every line height here is looser than a Latin-first scale would set.
   */
  lineHeight: {
    tight: '1.35',
    normal: '1.7',
    relaxed: '2',
  },
} as const

/**
 * Corner radii.
 *
 * Generous, and matched to the artwork: cards are `lg`, the pills in the top
 * bar and the CTA are `full` or `md`, and the app frame itself is `3xl`. Sharp
 * corners would fight a logo built entirely from arcs.
 */
export const borderRadius = {
  none: '0',
  sm: '0.375rem',
  md: '0.625rem',
  lg: '0.875rem',
  xl: '1.125rem',
  '2xl': '1.5rem',
  '3xl': '2rem',
  full: '9999px',
} as const

/**
 * Shadows tinted with the ink colour rather than black.
 *
 * A black shadow over warm paper turns grey and reads as grime; the same shadow
 * in brown reads as depth.
 */
export const shadows = {
  sm: '0 1px 2px 0 rgb(38 31 23 / 0.05)',
  md: '0 4px 10px -3px rgb(38 31 23 / 0.10)',
  lg: '0 12px 26px -12px rgb(38 31 23 / 0.18)',
  xl: '0 24px 48px -20px rgb(38 31 23 / 0.24)',
  /** For the action colour, so a button glows rather than casts. */
  action: '0 10px 22px -10px rgb(228 82 13 / 0.55)',
} as const

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const

export const zIndex = {
  base: '0',
  dropdown: '1000',
  sticky: '1100',
  fixed: '1200',
  modal: '1300',
  popover: '1400',
  tooltip: '1500',
} as const

/**
 * How things move.
 *
 * One duration and one curve for nearly everything, because an interface where
 * each component eases differently feels assembled rather than made.
 */
export const motion = {
  duration: { fast: '120ms', base: '200ms', slow: '320ms', reveal: '520ms' },
  easing: {
    /** Almost everything. Fast out of the gate, settles without a bounce. */
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    /** Leaving. Quicker than arriving, because nobody watches an exit. */
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
    /**
     * One overshoot, for things that appear under a finger: a badge counting
     * up, a card accepting a tap. Used anywhere else it turns an interface
     * into a toy.
     */
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    /** A long, flat curve for content arriving on scroll. */
    reveal: 'cubic-bezier(0.16, 1, 0.3, 1)',
  },
  /**
   * How far a revealed element travels before it settles.
   *
   * Small on purpose. Content that flies in from off-screen reads as a
   * slideshow; content that rises a few pixels reads as paper settling.
   */
  revealDistance: '14px',
  /** Between one revealed item and the next in a row. */
  stagger: '55ms',
} as const

// RTL-specific utilities
export const rtl = {
  direction: 'rtl',
  textAlign: 'right',
  logicalPropertyOrder: true, // Use logical properties (margin-inline-start vs margin-left)
} as const

/** Where the brand artwork lives, for anything that renders the mark. */
export const brandAssets = {
  lockup: '/brand/logo-lockup.png',
  mark: '/brand/logo-mark.png',
  markLight: '/brand/logo-mark-light.png',
  appIcon: '/brand/app-icon.png',
} as const

/**
 * The tokens as CSS custom properties.
 *
 * Generated rather than written out in a stylesheet, so the web cannot drift
 * from the mobile apps: both read the constants above, and this is the only
 * bridge between them.
 */
export function cssVariables(): string {
  const entries: string[] = []
  const push = (name: string, value: string) => entries.push(`  --${name}: ${value};`)

  for (const [step, value] of Object.entries(colors.primary)) push(`primary-${step}`, value)
  for (const [step, value] of Object.entries(colors.neutral)) push(`neutral-${step}`, value)
  for (const [name, value] of Object.entries(brand)) push(`brand-${name}`, value)
  for (const [name, value] of Object.entries(surface)) push(`surface-${name}`, value)
  for (const [name, value] of Object.entries(ink)) push(`ink-${name}`, value)
  for (const [name, value] of Object.entries(line)) push(`line-${name}`, value)
  for (const [name, value] of Object.entries(gradients)) push(`gradient-${name}`, value)
  for (const [state, values] of Object.entries(tint)) {
    for (const [part, value] of Object.entries(values)) push(`tint-${state}-${part}`, value)
  }
  for (const [name, value] of Object.entries(borderRadius)) push(`radius-${name}`, value)
  for (const [name, value] of Object.entries(shadows)) push(`shadow-${name}`, value)
  for (const [name, value] of Object.entries(motion.duration)) push(`duration-${name}`, value)
  for (const [name, value] of Object.entries(motion.easing)) push(`easing-${name}`, value)
  push('reveal-distance', motion.revealDistance)
  push('stagger', motion.stagger)
  for (const [name, values] of Object.entries(glass)) {
    for (const [part, value] of Object.entries(values)) push(`glass-${name}-${part}`, value)
  }
  for (const [name, value] of Object.entries(elevation)) push(`z-${name}`, String(value))
  push('success', colors.success)
  push('warning', colors.warning)
  push('error', colors.error)
  push('info', colors.info)
  push('font-body', typography.fontFamily.body.join(', '))

  return `:root {\n${entries.join('\n')}\n}`
}

export const config = {
  brand,
  colors,
  surface,
  ink,
  line,
  gradients,
  tint,
  glass,
  elevation,
  spacing,
  typography,
  borderRadius,
  shadows,
  breakpoints,
  zIndex,
  motion,
  rtl,
  brandAssets,
} as const

export type DesignTokens = typeof config
export default config
