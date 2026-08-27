import { Platform, StyleSheet, View, type ViewStyle } from 'react-native'
import { BlurView } from 'expo-blur'
import { glass, surface } from '@alo-noon/design-tokens'

/**
 * Glass on a phone, with the same rule as on the web: only for things that
 * float above other things.
 *
 * A blurred surface is not free here the way a `backdrop-filter` almost is on a
 * desktop browser — on Android it is a real GPU cost and on older devices it is
 * a visible one. So it is spent on the two surfaces that earn it, a pinned
 * header and a sheet, and everything else gets an opaque card.
 *
 * The tint is the brand's own paper rather than the platform's neutral grey.
 * Apple's default material under this palette turns the warm background cold,
 * which is exactly the kind of borrowed-look detail that makes an app feel like
 * a template.
 */
export function GlassSurface({
  variant = 'bar',
  style,
  children,
}: {
  variant?: 'bar' | 'sheet'
  style?: ViewStyle | ViewStyle[]
  children?: React.ReactNode
}) {
  const material = variant === 'sheet' ? glass.sheet : glass.bar

  // Android's blur support is uneven across versions and vendors; a solid warm
  // surface there is better than a blur that renders as a grey slab on a third
  // of devices.
  if (Platform.OS === 'android') {
    return (
      <View style={[styles.base, { backgroundColor: material.fallback }, style]}>{children}</View>
    )
  }

  return (
    <BlurView intensity={variant === 'sheet' ? 44 : 28} tint="light" style={[styles.base, style]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tintOf(material.background) }]} />
      {children}
    </BlurView>
  )
}

/**
 * The material's own tint, kept translucent so the blur beneath still shows.
 *
 * The token is a CSS `rgba()` string because the web reads the same value; this
 * turns it into something React Native accepts, and falls back to the opaque
 * surface rather than to `undefined` — a missing background on glass is a
 * transparent bar with unreadable text over a photograph.
 */
function tintOf(cssColour: string): string {
  const match = /rgba?\(([^)]+)\)/.exec(cssColour)
  if (!match) return surface.card
  const parts = match[1]!.split(',').map((value) => value.trim())
  const [r, g, b, a = '1'] = parts
  if (!r || !g || !b) return surface.card
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
})
