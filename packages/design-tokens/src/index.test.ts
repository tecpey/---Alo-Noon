import { describe, expect, it } from 'vitest'

import { brand, colors, cssVariables, gradients, ink, mix, surface, tint, touch } from './index'

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
    //
    // It is darker than either — 800, not the 600 it used to be — because the
    // action colour is the only one of the three that has to be *read*, on a
    // price and inside a button, and the contrast test below is what settled
    // which step of the ramp that takes.
    expect(ink.action).toBe(colors.primary[800])
    expect(ink.action).not.toBe(colors.primary[500])
    expect(ink.action).not.toBe(colors.primary[600])
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

describe('the touch floor', () => {
  it('is the same distance on the web and on a phone', () => {
    // The two platforms count in different units, so the token carries both.
    // Nothing stops someone raising one and forgetting the other except this:
    // the failure would be a control that is comfortable in the browser and
    // cramped in the Android app, which nobody would think to go looking for.
    const points = (rem: string) => Number.parseFloat(rem) * 16
    expect(points(touch.min)).toBe(touch.minPoints)
    expect(points(touch.comfortable)).toBe(touch.comfortablePoints)
  })

  it('is at least the 44px both WCAG and Apple settled on', () => {
    expect(touch.minPoints).toBeGreaterThanOrEqual(44)
    expect(touch.comfortablePoints).toBeGreaterThan(touch.minPoints)
  })

  it('reaches CSS as a length, and only the halves that are lengths', () => {
    const css = cssVariables()
    expect(css).toContain(`--touch-min: ${touch.min};`)
    // A unitless 44 in a `min-block-size` is a declaration the browser drops.
    expect(css).not.toContain('--touch-minPoints')
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

/**
 * The contrast every text role owes the surface it is read on.
 *
 * This exists because the storefront shipped failing it. Measured on the
 * running page, the price of the bread sat at 3.46:1 and every primary button
 * at 3.81:1 — the two things on the screen a customer most needs to read. The
 * numbers came back from a browser, and nothing in the repository would have
 * caught them, because a colour that fails contrast is not a colour that looks
 * broken. It looks like a brand.
 *
 * So the arithmetic lives here now, next to the tokens, and runs on every
 * commit. A future palette change that drops a text role below its floor fails
 * the build rather than reaching a customer's eyes.
 *
 * WCAG 2.x relative luminance, from the specification rather than approximated:
 * linearise each channel, weight by 0.2126/0.7152/0.0722, and compare the
 * lighter of the pair to the darker with the 0.05 flare term on both.
 */
describe('text contrast against real surfaces', () => {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
  }
  const contrast = (foreground: string, background: string) => {
    const [a, b] = [luminance(foreground), luminance(background)]
    const [high, low] = a > b ? [a, b] : [b, a]
    return (high + 0.05) / (low + 0.05)
  }

  /** WCAG 1.4.3 (AA) for body text. Large text may sit at 3. */
  const BODY_MINIMUM = 4.5

  const readableSurfaces = [
    ['page', surface.page],
    ['base', surface.base],
    ['card', surface.card],
    ['sunken', surface.sunken],
  ] as const

  for (const [name, background] of readableSurfaces) {
    it(`carries strong, base, muted and action text on the ${name} surface`, () => {
      for (const role of ['strong', 'base', 'muted', 'action'] as const) {
        const measured = contrast(ink[role], background)
        expect(
          measured,
          `ink.${role} (${ink[role]}) on surface.${name} (${background}) is ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BODY_MINIMUM)
      }
    })
  }

  /**
   * A state's text is its `tint.*.ink`, never the raw state colour.
   *
   * The raw colours are for borders, icons and fills — things WCAG asks 3:1 of.
   * Used as text they fail: measured on the page surface, `warning` is 2.57:1,
   * `success` 3.77, `error` 4.11 and `info` 4.38. The admin panel's gateway
   * health badges set "degraded" in raw amber on an amber tint at 2.74:1, and
   * the wallet's "credited" line, the checkout refusal and the sign-out button
   * on the phone all used raw colours too. The inks were already here; nothing
   * held anyone to them, and the check above this one only asked that an ink be
   * darker than its tint.
   *
   * So each ink has to carry body text on its own tint and on every surface a
   * state message can land on outside a tinted box.
   */
  it('gives every state an ink that reads on its tint and on every surface', () => {
    for (const [state, values] of Object.entries(tint)) {
      for (const [name, background] of [
        ['its own tint', values.surface],
        ...readableSurfaces,
      ] as const) {
        const measured = contrast(values.ink, background)
        expect(
          measured,
          `tint.${state}.ink (${values.ink}) on ${name} (${background}) is ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BODY_MINIMUM)
      }
    }
  })

  it('carries its own text on the action colour, which is what every button is', () => {
    // White-on-orange is the primary button, the checkout button and the
    // sign-in button. It failed at 3.81:1 before the action role moved to 700.
    const measured = contrast(ink.onAction, ink.action)
    expect(
      measured,
      `ink.onAction on ink.action is ${measured.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(BODY_MINIMUM)
  })

  it('carries light text on the inverse surface', () => {
    expect(contrast(colors.paper, surface.inverse)).toBeGreaterThanOrEqual(BODY_MINIMUM)
  })

  /**
   * `faint` is excluded on purpose and pinned here so the exclusion is a
   * decision rather than an oversight: it dresses placeholders and disabled
   * controls, which WCAG 1.4.3 exempts, and raising it would make a disabled
   * button indistinguishable from a live one.
   */
  it('keeps faint below the body floor, because it marks what cannot be used', () => {
    expect(contrast(ink.faint, surface.card)).toBeLessThan(BODY_MINIMUM)
  })
})
