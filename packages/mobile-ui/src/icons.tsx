import { Circle, G, Path, Rect, Svg } from 'react-native-svg'
import { ink } from '@alo-noon/design-tokens'

/**
 * The same icon set the web draws, in React Native's SVG.
 *
 * Deliberately the same paths rather than a mobile-flavoured redraw: the two
 * surfaces are one product, and an icon that is a slightly different shape on a
 * phone is the kind of difference nobody can name but everybody feels.
 *
 * They live in a shared package rather than in either app because the courier
 * app and the customer app both need them, and copying a set of glyphs between
 * two applications is how the two sets stop matching within a month. The
 * repository forbids one app importing another for exactly this reason.
 */
export interface IconProps {
  size?: number
  color?: string
  /** Draws a filled accent under the stroke, in the same colour at low opacity. */
  duotone?: boolean
}

function base({ size = 22, color = ink.base }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
}

export function PinIcon(props: IconProps) {
  const { color = ink.base, duotone } = props
  return (
    <Svg {...base(props)}>
      {duotone && (
        <G fill={color} stroke="none" opacity={0.16}>
          <Path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
        </G>
      )}
      <Path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
      <Circle cx="12" cy="10" r="2.6" />
    </Svg>
  )
}

export function ClockIcon(props: IconProps) {
  const { color = ink.base, duotone } = props
  return (
    <Svg {...base(props)}>
      {duotone && (
        <G fill={color} stroke="none" opacity={0.16}>
          <Circle cx="12" cy="12" r="8.4" />
        </G>
      )}
      <Circle cx="12" cy="12" r="8.4" />
      <Path d="M12 7.6V12l3 1.8" />
    </Svg>
  )
}

export function CartIcon(props: IconProps) {
  const { color = ink.base, duotone } = props
  return (
    <Svg {...base(props)}>
      {duotone && (
        <G fill={color} stroke="none" opacity={0.16}>
          <Path d="M6.3 8.6h14l-1.5 6.1a1.6 1.6 0 0 1-1.6 1.2H9.5a1.6 1.6 0 0 1-1.6-1.3L6.3 8.6Z" />
        </G>
      )}
      <Path d="M3.4 4.4h2.2l2.3 10.2a1.6 1.6 0 0 0 1.6 1.3h7.6a1.6 1.6 0 0 0 1.6-1.2l1.5-6.1H6.3" />
      <Circle cx="10" cy="19.6" r="1.3" />
      <Circle cx="17.2" cy="19.6" r="1.3" />
    </Svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...base(props)}>
      <Path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...base(props)}>
      <Path d="m5 12.6 4.4 4.4L19 7.4" />
    </Svg>
  )
}

export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...base(props)}>
      <Path d="M14.5 5.5 8 12l6.5 6.5" />
    </Svg>
  )
}

/** The mark's own steam. The cheapest way to sign a section at 16 pixels. */
export function SteamIcon(props: IconProps) {
  return (
    <Svg {...base(props)}>
      <Path d="M8 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
      <Path d="M12 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
      <Path d="M16 19c-1.6-2.2-1.6-4 0-6.2s1.6-4 0-6.2" />
    </Svg>
  )
}

/** A domed oven. Freshness said as a place rather than as a word. */
export function OvenIcon(props: IconProps) {
  const { color = ink.base, duotone } = props
  return (
    <Svg {...base(props)}>
      {duotone && (
        <G fill={color} stroke="none" opacity={0.16}>
          <Path d="M3.4 19.4v-5.9a8.6 8.6 0 0 1 17.2 0v5.9Z" />
        </G>
      )}
      <Path d="M3.4 19.6v-6.1a8.6 8.6 0 0 1 17.2 0v6.1" />
      <Path d="M2.4 19.6h19.2" />
      <Path d="M8.4 19.5v-3.1a3.6 3.6 0 0 1 7.2 0v3.1" />
    </Svg>
  )
}

/** The courier, on the motorcycle that actually does this job. */
export function CourierIcon(props: IconProps) {
  const { color = ink.base, duotone } = props
  return (
    <Svg {...base(props)}>
      {duotone && (
        <G fill={color} stroke="none" opacity={0.16}>
          <Rect x="12.6" y="7.4" width="6" height="5" rx="1.4" />
        </G>
      )}
      <Circle cx="5.4" cy="17.2" r="2.8" />
      <Circle cx="18.6" cy="17.2" r="2.8" />
      <Path d="M8.2 17.2h7.6" />
      <Path d="M5.4 17.2 9 9.4h4.2" />
      <Path d="M13.2 7.4h4.6a1.4 1.4 0 0 1 1.4 1.4v8.4" />
      <Path d="M11.6 9.4h6" />
    </Svg>
  )
}

export function ShieldIcon(props: IconProps) {
  const { color = ink.base, duotone } = props
  return (
    <Svg {...base(props)}>
      {duotone && (
        <G fill={color} stroke="none" opacity={0.16}>
          <Path d="M12 3.2l7 2.8v5.6c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V6Z" />
        </G>
      )}
      <Path d="M12 3.2l7 2.8v5.6c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2V6Z" />
      <Path d="m8.9 12 2.2 2.2 4-4.3" />
    </Svg>
  )
}
