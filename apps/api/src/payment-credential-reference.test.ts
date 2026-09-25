import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { CREDENTIAL_REFERENCE_PATTERN } from './modules/payment-provider'
import {
  createLocalEncryptedPaymentSecretResolver,
  encryptPaymentSecret,
} from './providers/secret-resolver'

/**
 * A reference is a *name*, never a secret — and this is what holds that line.
 *
 * It is written down because the line was nearly erased. `provision
 * encrypt-payment-secret` prints an AES-GCM blob in standard base64, which uses
 * `+` and `=`; the stored reference's character class allows neither. That
 * looks exactly like a bug — two commands of one project disagreeing — and
 * measuring it made it look worse: zero of two thousand blobs were accepted.
 * The class was widened to let them through.
 *
 * It was not a bug. `secret-resolver.ts` reads `local-encrypted://<NAME>` as the
 * name of the environment entry `PAYMENT_SECRET_<NAME>` that holds the blob; the
 * decryption key arrives separately and is never one of those entries. The blob
 * was never meant to appear in the reference at all. Widening the class would
 * have let a gateway's ciphertext be written into a row whose whole purpose is
 * to hold no secret, undoing the property the scheme exists for: leaking the
 * configuration does not leak the credential.
 *
 * So the round trip below runs in the opposite direction from the one that was
 * nearly written, and it is split in two, because the two gates do not promise
 * the same thing.
 */
describe('a gateway credential reference', () => {
  const key = randomBytes(32)
  /* The resolver takes these for its own logging; neither reaches the lookup. */
  const TENANT = '00000000-0000-4000-8000-000000000001'

  /*
    Gate one: the shape allowed into the database, mirrored from the
    `ProviderCredential_reference_check` CHECK constraint.
  */
  describe('the stored shape', () => {
    it('accepts the name of the environment entry, which is the documented form', () => {
      // What `provision configure-payment-gateway` is actually given on launch
      // day: the blob goes in `PAYMENT_SECRET_ZARINPAL_MERCHANT`, and the row
      // names it.
      for (const reference of [
        'local-encrypted://ZARINPAL_MERCHANT',
        'local-encrypted://ZIBAL',
        'local-encrypted://IDPAY_API_KEY',
      ])
        expect(CREDENTIAL_REFERENCE_PATTERN.test(reference), reference).toBe(true)
    })

    it('still takes the external secret managers', () => {
      for (const reference of [
        'vault://secret/data/alo-noon/zarinpal',
        'aws-sm://prod/alo-noon/zarinpal-merchant',
        'gcp-sm://projects/alo-noon/secrets/zarinpal/versions/3',
      ])
        expect(CREDENTIAL_REFERENCE_PATTERN.test(reference), reference).toBe(true)
    })

    it('refuses anything that is not one of the four schemes', () => {
      for (const reference of [
        'sandbox-merchant-not-real',
        'https://example.test/secret',
        'local-encrypted://',
        // `env://` is the SMS and fare-provider scheme. Payments deliberately
        // do not share it: those references name a plaintext variable, and a
        // gateway secret is never held in one.
        'env://PAYMENT_GATEWAY_ZARINPAL',
        'local-encrypted://has space',
      ])
        expect(CREDENTIAL_REFERENCE_PATTERN.test(reference), reference).toBe(false)
    })

    it('turns most ciphertext away at the door, but is not the thing that stops it', () => {
      // Measured, rather than assumed, because the number is the point. Most
      // blobs carry `+` or `=` and are refused. Roughly one in seven does not —
      // when the byte length is divisible by three there is no padding, and the
      // random bytes may contain no `+` — and such a blob is, by shape alone,
      // indistinguishable from a name. A CHECK constraint cannot tell them
      // apart, which is why the test below exists.
      let accepted = 0
      const total = 2000
      for (let attempt = 0; attempt < total; attempt += 1) {
        const blob = encryptPaymentSecret('x'.repeat((attempt % 24) + 1), key)
        if (CREDENTIAL_REFERENCE_PATTERN.test(`local-encrypted://${blob}`)) accepted += 1
      }
      expect(accepted).toBeGreaterThan(0)
      expect(accepted / total).toBeLessThan(0.25)
    })
  })

  /*
    Gate two: the resolver, which is the exact one. Its own pattern is
    `[A-Z][A-Z0-9_]*` — upper case, digits and underscore. Base64 has lower-case
    letters in it, so no blob can ever be read as a name.
  */
  describe('the resolver', () => {
    it('refuses ciphertext as a reference, at every secret length', async () => {
      const resolver = createLocalEncryptedPaymentSecretResolver({}, key)
      for (let length = 1; length <= 24; length += 1) {
        const blob = encryptPaymentSecret('x'.repeat(length), key)
        await expect(
          resolver.resolve(`local-encrypted://${blob}`, TENANT, 'ZARINPAL'),
        ).rejects.toThrow('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE')
      }
    })

    it('opens the blob that the named entry holds', async () => {
      // The documented path end to end, so the refusal above cannot be passing
      // because nothing resolves at all.
      const blob = encryptPaymentSecret('sandbox-merchant-not-real', key)
      const resolver = createLocalEncryptedPaymentSecretResolver(
        { PAYMENT_SECRET_ZARINPAL_MERCHANT: blob },
        key,
      )
      const secret = await resolver.resolve(
        'local-encrypted://ZARINPAL_MERCHANT',
        TENANT,
        'ZARINPAL',
      )
      expect(Buffer.from(secret.material).toString('utf8')).toBe('sandbox-merchant-not-real')
      secret.dispose()
      expect(secret.material.every((byte) => byte === 0)).toBe(true)
    })
  })
})
