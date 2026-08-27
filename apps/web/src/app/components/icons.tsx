import type { SVGProps } from 'react'

/**
 * The interface's icons, drawn rather than installed.
 *
 * One weight, one corner treatment, one grid — an icon set assembled from a
 * library shows its seams immediately next to a logo this specific. They take
 * their colour from the text around them, so an icon inside a button on the
 * action colour needs no variant.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </Icon>
  )
}

export function BagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 8h13l-1 11.2a1.8 1.8 0 0 1-1.8 1.6H8.3a1.8 1.8 0 0 1-1.8-1.6L5.5 8Z" />
      <path d="M9 8V6.6a3 3 0 0 1 6 0V8" />
    </Icon>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.6V12l3 1.8" />
    </Icon>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m16 16 4 4" />
    </Icon>
  )
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5.4 20a6.6 6.6 0 0 1 13.2 0" />
    </Icon>
  )
}

export function CartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.4 4.4h2.2l2.3 10.2a1.6 1.6 0 0 0 1.6 1.3h7.6a1.6 1.6 0 0 0 1.6-1.2l1.5-6.1H6.3" />
      <circle cx="10" cy="19.6" r="1.3" />
      <circle cx="17.2" cy="19.6" r="1.3" />
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

/** The mark's own steam, reused as the eyebrow beside every section title. */
export function SteamIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
      <path d="M12 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
      <path d="M16 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
    </Icon>
  )
}
