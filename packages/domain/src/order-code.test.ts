import { describe, expect, it } from 'vitest'

import { generateOrderCode, isOrderCode, ORDER_CODE_LENGTH, ORDER_CODE_PATTERN } from './order-code'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('order codes', () => {
  it('never puts two symbols a customer could confuse in the same alphabet', () => {
    // A symbol is only ambiguous when its look-alike is also available: L is
    // safe here precisely because there is no 1 to mistake it for. So the rule
    // is not "ban these letters" but "never ship both halves of a pair".
    const alphabet = new Set<string>()
    for (let value = 0; value < 256; value += 1) {
      alphabet.add(generateOrderCode(() => new Uint8Array(ORDER_CODE_LENGTH).fill(value))[0]!)
    }
    for (const pair of [
      ['0', 'O'],
      ['1', 'I'],
      ['1', 'L'],
      ['U', 'V'],
    ]) {
      expect(pair.every((symbol) => alphabet.has(symbol))).toBe(false)
    }
    // 5/S and 8/B are deliberately both present: they are told apart by shape at
    // any readable size, and dropping them would take the alphabet below the
    // thirty-two symbols that keep the modulo below unbiased.
    expect(alphabet.has('5') && alphabet.has('S')).toBe(true)
  })

  it('is short enough to keep a Persian notification to one paid message', () => {
    const code = generateOrderCode(() => bytes(1, 2, 3, 4, 5, 6, 7, 8))
    expect(code).toHaveLength(ORDER_CODE_LENGTH)
    // The 25-character cuid this replaced pushed every order message past the
    // 70-unit single-message limit, doubling what the tenant paid to send it.
    const message = `سفارش ${code} پذیرفته شد و به‌زودی آماده می‌شود. الو نون`
    expect([...message].length).toBeLessThanOrEqual(70)
  })

  it('spreads evenly across the alphabet rather than favouring its start', () => {
    // 256 is a whole multiple of 32, so a plain modulo is uniform. If the
    // alphabet ever changes size this is what catches the resulting bias.
    const counts = new Map<string, number>()
    for (let value = 0; value < 256; value += 1) {
      const symbol = generateOrderCode(() => new Uint8Array(ORDER_CODE_LENGTH).fill(value))[0]!
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
    }
    expect(new Set(counts.values())).toEqual(new Set([8]))
  })

  it('refuses a random source that did not give it what it asked for', () => {
    expect(() => generateOrderCode(() => bytes(1, 2))).toThrow(/one random byte per symbol/)
  })

  it('recognises its own codes and nothing else', () => {
    expect(isOrderCode(generateOrderCode(() => bytes(9, 8, 7, 6, 5, 4, 3, 2)))).toBe(true)
    for (const bad of ['', 'SHORT', 'lowercase', 'AAAAAAAO', 'AAAAAAAAA']) {
      expect(isOrderCode(bad)).toBe(false)
    }
    // Anchored, so a valid code buried in other text is not accepted.
    expect(ORDER_CODE_PATTERN.test(' ABCDEFGH ')).toBe(false)
  })
})
