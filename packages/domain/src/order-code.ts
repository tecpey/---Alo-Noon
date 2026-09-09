import { DomainError } from './errors'

/**
 * The code a customer reads back down the phone.
 *
 * Orders used to take a 25-character cuid for this, which cost real money and
 * real patience. It cannot be read aloud — "see em tee nine pee ay see tee
 * seven zero zero zero ell..." — and, because Persian SMS is UCS-2 with only 70
 * characters in a single message, those 25 characters pushed every order
 * notification into a second paid part. Four messages an order, doubled, for an
 * identifier nobody can use.
 *
 * Eight characters of Crockford's base32 alphabet fixes both. Its rule is not
 * "avoid awkward letters" but "never ship both halves of a confusable pair":
 * it keeps 0 and 1 and drops O, I and L, so a code read over a bad line has no
 * second reading. 5/S and 8/B both survive because they are told apart by shape
 * at any readable size, while 0/O and 1/l are not.
 *
 * Thirty-two symbols to the eighth is about a trillion codes; the unique index
 * is what actually guarantees uniqueness, and callers retry on the rare
 * collision rather than trusting the arithmetic.
 *
 * The internal `id` is untouched and stays a UUID. This is the public face of an
 * order, not its identity.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ORDER_CODE_LENGTH = 8

/** Matches a generated code. Anchored, because it is used to accept input. */
export const ORDER_CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${ORDER_CODE_LENGTH}}$`)

/**
 * @param randomBytes must return `length` cryptographically random bytes. Passed
 * in rather than reached for so this package keeps no runtime dependency, and so
 * a test can pin the output.
 */
export function generateOrderCode(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(ORDER_CODE_LENGTH)
  if (bytes.length !== ORDER_CODE_LENGTH) {
    throw new DomainError(
      'INVALID_ORDER_CODE_SOURCE',
      'Order code needs one random byte per symbol',
    )
  }
  let code = ''
  for (const byte of bytes) {
    // 256 is a whole multiple of 32, so the modulo is uniform across the
    // alphabet rather than favouring its first eight symbols.
    code += ALPHABET[byte % ALPHABET.length]
  }
  return code
}

export function isOrderCode(value: string): boolean {
  return ORDER_CODE_PATTERN.test(value)
}
