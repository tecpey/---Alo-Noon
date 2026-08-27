import type { ReactNode, SVGProps } from 'react'

/**
 * The icon set, drawn rather than installed.
 *
 * One grid (24), one stroke (1.7), round caps and joins throughout, and a
 * consistent optical weight — the arch of the logo is a round, generous curve,
 * and a set of tight geometric icons next to it looks borrowed. An icon library
 * dropped in beside a mark this specific shows its seams on the first screen.
 *
 * Two things make this set carry the brand rather than merely coexist with it.
 *
 * **Duotone.** Every icon can render a filled accent shape underneath the
 * stroke, in the brand orange at low opacity. Turned on for the few icons that
 * carry meaning at a glance — the basket that has something in it, the tab you
 * are on — and off everywhere else, so the accent still means something.
 *
 * **Bread has its own glyphs.** A courier, an oven, a wheat sprig and a steam
 * curl are drawn here rather than approximated with a truck, a box and a fire
 * from a general-purpose set. They are the nouns this product is about.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** Draws the accent shape beneath the stroke. Off by default, deliberately. */
  duotone?: boolean
}

function Icon({
  children,
  accent,
  duotone = false,
  ...props
}: IconProps & { children: ReactNode; accent?: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {duotone && accent ? (
        <g fill="currentColor" stroke="none" opacity="0.16">
          {accent}
        </g>
      ) : null}
      {children}
    </svg>
  )
}

/* ------------------------------------------------------------- wayfinding */

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />}>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </Icon>
  )
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z" />}>
      <path d="M3.6 11 12 4.2l8.4 6.8" />
      <path d="M5.6 9.9V19a1.4 1.4 0 0 0 1.4 1.4h10a1.4 1.4 0 0 0 1.4-1.4V9.9" />
      <path d="M9.9 20.4v-5.1a2.1 2.1 0 0 1 4.2 0v5.1" />
    </Icon>
  )
}

export function GridIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      accent={
        <>
          <rect x="3.6" y="3.6" width="7" height="7" rx="2.2" />
          <rect x="13.4" y="13.4" width="7" height="7" rx="2.2" />
        </>
      }
    >
      <rect x="3.6" y="3.6" width="7" height="7" rx="2.2" />
      <rect x="13.4" y="3.6" width="7" height="7" rx="2.2" />
      <rect x="3.6" y="13.4" width="7" height="7" rx="2.2" />
      <rect x="13.4" y="13.4" width="7" height="7" rx="2.2" />
    </Icon>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<circle cx="11" cy="11" r="6.4" />}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m16 16 4 4" />
    </Icon>
  )
}

export function ChevronIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  )
}

/* ------------------------------------------------------------- commerce */

export function BagIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      accent={<path d="M5.5 8h13l-1 11.2a1.8 1.8 0 0 1-1.8 1.6H8.3a1.8 1.8 0 0 1-1.8-1.6L5.5 8Z" />}
    >
      <path d="M5.5 8h13l-1 11.2a1.8 1.8 0 0 1-1.8 1.6H8.3a1.8 1.8 0 0 1-1.8-1.6L5.5 8Z" />
      <path d="M9 8V6.6a3 3 0 0 1 6 0V8" />
    </Icon>
  )
}

export function CartIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      accent={
        <path d="M6.3 8.6h14l-1.5 6.1a1.6 1.6 0 0 1-1.6 1.2H9.5a1.6 1.6 0 0 1-1.6-1.3L6.3 8.6Z" />
      }
    >
      <path d="M3.4 4.4h2.2l2.3 10.2a1.6 1.6 0 0 0 1.6 1.3h7.6a1.6 1.6 0 0 0 1.6-1.2l1.5-6.1H6.3" />
      <circle cx="10" cy="19.6" r="1.3" />
      <circle cx="17.2" cy="19.6" r="1.3" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Icon>
  )
}

export function ReceiptIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<path d="M5.6 3.4h12.8v17.2l-2.6-1.6-2.6 1.6-2.6-1.6-2.4 1.6Z" />}>
      <path d="M5.6 3.4h12.8v17.2l-2.6-1.6-2.6 1.6-2.6-1.6-2.4 1.6Z" />
      <path d="M9 8.4h6M9 12.4h6" />
    </Icon>
  )
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<circle cx="12" cy="8.4" r="3.6" />}>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5.4 20a6.6 6.6 0 0 1 13.2 0" />
    </Icon>
  )
}

/* ----------------------------------------------------------------- bread */

/**
 * The mark's own steam, reused as the eyebrow beside every section title.
 *
 * It is the one shape from the logo small enough to survive at 16 pixels, which
 * makes it the cheapest way to sign a section without stamping a whole mark on
 * it.
 */
export function SteamIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
      <path d="M12 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
      <path d="M16 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
    </Icon>
  )
}

/** A wheat sprig. The raw material, and the ornament the brand keeps returning to. */
export function WheatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 21V9.5" />
      <path d="M12 9.4c0-2.1 1-3.9 2.6-5.2 1 1.9 1 4-.1 5.6-1 1.4-2.5 1.5-2.5-.4Z" />
      <path d="M12 9.4c0-2.1-1-3.9-2.6-5.2-1 1.9-1 4 .1 5.6 1 1.4 2.5 1.5 2.5-.4Z" />
      <path d="M12 15.4c0-2-1-3.6-2.6-4.8-1 1.8-1 3.8.1 5.3 1 1.3 2.5 1.4 2.5-.5Z" />
      <path d="M12 15.4c0-2 1-3.6 2.6-4.8 1 1.8 1 3.8-.1 5.3-1 1.3-2.5 1.4-2.5-.5Z" />
    </Icon>
  )
}

/** A domed oven with a mouth. Freshness, said as a place rather than a word. */
export function OvenIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<path d="M3.4 19.4v-5.9a8.6 8.6 0 0 1 17.2 0v5.9Z" />}>
      <path d="M3.4 19.6v-6.1a8.6 8.6 0 0 1 17.2 0v6.1" />
      <path d="M2.4 19.6h19.2" />
      <path d="M8.4 19.5v-3.1a3.6 3.6 0 0 1 7.2 0v3.1" />
    </Icon>
  )
}

/** The courier, on the motorcycle that actually does this job in an Iranian city. */
export function CourierIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<rect x="12.6" y="7.4" width="6" height="5" rx="1.4" />}>
      <circle cx="5.4" cy="17.2" r="2.8" />
      <circle cx="18.6" cy="17.2" r="2.8" />
      <path d="M8.2 17.2h7.6" />
      <path d="M5.4 17.2 9 9.4h4.2" />
      <path d="M13.2 7.4h4.6a1.4 1.4 0 0 1 1.4 1.4v8.4" />
      <path d="M11.6 9.4h6" />
    </Icon>
  )
}

/* ---------------------------------------------------------------- status */

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<circle cx="12" cy="12" r="8.4" />}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.6V12l3 1.8" />
    </Icon>
  )
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon
      {...props}
      accent={<path d="M12 3.2l7 2.8v5.6c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V6Z" />}
    >
      <path d="M12 3.2l7 2.8v5.6c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V6Z" />
      <path d="m8.9 12 2.2 2.2 4-4.3" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.6 4.4 4.4L19 7.4" />
    </Icon>
  )
}

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props} accent={<path d="M6 17.2V11a6 6 0 0 1 12 0v6.2Z" />}>
      <path d="M6 17.2V11a6 6 0 0 1 12 0v6.2l1.4 1.6H4.6Z" />
      <path d="M10.2 21.2a2 2 0 0 0 3.6 0" />
    </Icon>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.4" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  )
}
