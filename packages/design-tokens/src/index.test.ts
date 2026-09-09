import { describe, expect, it } from 'vitest'

import { brand, colors, cssVariables, gradients, ink, mix, surface, tint } from './index'

/**
 * The tokens are data, so most of them are not worth a test. What is worth one
 * is the bridge: the web reads these constants through `cssVariables`, the
 * mobile apps read them directly, and if that emitter ever drops a group the
 * web silently falls back to unstyled defaults on colours it believes it set.
 */
describe('the palette', () => {
  it('takes its oranges from the logo, not from a stock ramp', () => {
    // Sampled off the artwork. If someone swaps in a library orange, the mark
    // and the interface stop being the same colour and nobody notices for weeks.
    expect(colors.primary[500]).toBe(brand.ember)
    expect(colors.neutral[900]).toBe(brand.ink)
  })

  it('keeps the action colour distinct from the brand colour', () => {
    // The brand appears; the action commands. One value doing both jobs is how
    // a page ends up with six things all asking to be pressed.
    expect(ink.action).toBe(colors.primary[600])
    expect(ink.action).not.toBe(colors.primary[500])
  })

  it('has no pure white or pure black anywhere in it', () => {
    // Both punch holes in warm paper. The inverse surface is brown, and the
    // lightest ink is a warm off-white.
    const values = [...Object.values(surface), ...Object.values(ink)]
    for (const value of values) {
      expect(value.toUpperCase()).not.toBe('#FFFFFF')
      expect(value.toUpperCase()).not.toBe('#000000')
    }
  })
})

describe('the bridge to CSS', () => {
  it('emits every group the stylesheets read', () => {
    const css = cssVariables()
    for (const name of [
      '--primary-600',
      '--neutral-900',
      '--brand-ember',
      '--surface-card',
      '--ink-muted',
      '--line-subtle',
      '--gradient-brandArc',
      '--radius-lg',
      '--shadow-action',
      '--duration-base',
      '--easing-standard',
      '--font-body',
      '--font-mono',
    ]) {
      expect(css).toContain(name)
    }
  })

  it('emits the same values the mobile apps read', () => {
    const css = cssVariables()
    expect(css).toContain(`--primary-600: ${colors.primary[600]};`)
    expect(css).toContain(`--gradient-brandArc: ${gradients.brandArc};`)
  })

  it('produces a single root block', () => {
    const css = cssVariables()
    expect(css.startsWith(':root {')).toBe(true)
    expect(css.trimEnd().endsWith('}')).toBe(true)
    expect(css.match(/:root/g)).toHaveLength(1)
  })
})

describe('state tints', () => {
  it('mixes rather than picks, so a retuned state carries its background', () => {
    expect(mix('#FFFFFF', '#000000', 0.5)).toBe('#808080')
    expect(mix('#FFFFFF', '#000000', 0)).toBe('#FFFFFF')
    expect(mix('#FFFFFF', '#000000', 1)).toBe('#000000')
  })

  it('clamps a weight outside the range instead of producing a broken colour', () => {
    expect(mix('#FFFFFF', '#000000', 5)).toBe('#000000')
    expect(mix('#FFFFFF', '#000000', -2)).toBe('#FFFFFF')
  })

  it('keeps every tint readable against its own background', () => {
    // Not a full contrast implementation — just the failure that matters: a
    // tint whose text is no darker than the surface it sits on.
    const luminance = (hex: string) =>
      [1, 3, 5].reduce((sum, at) => sum + parseInt(hex.slice(at, at + 2), 16), 0)
    for (const values of Object.values(tint)) {
      expect(luminance(values.ink)).toBeLessThan(luminance(values.surface) - 200)
    }
  })
})
