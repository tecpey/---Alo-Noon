import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  MAX_PUSH_PLAINTEXT_OCTETS,
  WebPushCryptoError,
  encryptWebPushPayload,
  generateVapidKeys,
  vapidAuthorization,
} from './web-push-crypto'

/**
 * The specifications' own worked examples, run against our implementation.
 *
 * This is not a test of intended behaviour and it is not written the way the
 * other tests in this repository are. Web Push encryption that is subtly wrong
 * never announces itself: the push service returns 201, the browser cannot
 * decrypt what arrives and drops it without telling anybody, and the customer
 * is simply never told their bread is at the door. There is no log to read and
 * no exception to catch.
 *
 * What can be checked is agreement. RFC 8291 publishes a complete example with
 * every intermediate value, and RFC 8292 publishes a signed token with the
 * public key that signed it. Both are what Chrome, Firefox and Safari
 * implement. Reproducing them byte for byte is the only evidence available that
 * this code does the same thing, and the values below are copied from the RFCs
 * rather than captured from a run — a captured value proves only that the code
 * still does what it did.
 */

// RFC 8291 §5 and appendix A.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  subscriptionPublicKey:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublicKey:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // The complete aes128gcm body from §5: the 86-octet header, then the record.
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  // Appendix A, quoted so a failure says which step went wrong rather than
  // "the output differs".
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

const subscriptionKeys = {
  p256dh: RFC8291.subscriptionPublicKey,
  auth: RFC8291.authSecret,
}

function rfcEncrypt(plaintext = RFC8291.plaintext) {
  return encryptWebPushPayload(Buffer.from(plaintext, 'utf8'), subscriptionKeys, {
    salt: Buffer.from(RFC8291.salt, 'base64url'),
    senderPrivateKey: Buffer.from(RFC8291.senderPrivateKey, 'base64url'),
  })
}

describe('RFC 8291 push message encryption', () => {
  it('produces the specification’s example body, byte for byte', () => {
    expect(rfcEncrypt().toString('base64url')).toBe(RFC8291.body)
  })

  it('writes the header the specification describes', () => {
    // Salt, then the record size as a big-endian uint32, then the length of the
    // sender's public key, then the key. A record size written little-endian
    // still produces a header of the right length and a message no browser can
    // read.
    const header = rfcEncrypt().subarray(0, 86)
    expect(header.toString('base64url')).toBe(RFC8291.header)
    expect(header.readUInt32BE(16)).toBe(4096)
    expect(header.readUInt8(20)).toBe(65)
    expect(header.subarray(21).toString('base64url')).toBe(RFC8291.senderPublicKey)
  })

  it('produces the specification’s ciphertext and authentication tag', () => {
    expect(rfcEncrypt().subarray(86).toString('base64url')).toBe(RFC8291.ciphertext)
  })

  it('appends the last-record delimiter, which is what sizes the record', () => {
    // Plaintext, one delimiter octet, sixteen octets of GCM tag.
    const plaintext = Buffer.from(RFC8291.plaintext, 'utf8').byteLength
    expect(rfcEncrypt().byteLength).toBe(86 + plaintext + 1 + 16)
  })

  it('uses a new salt and a new key pair on every send', () => {
    // Reusing either would reuse the AES-GCM nonce across two messages under
    // one key, which is the failure that loses the key rather than the message.
    const first = encryptWebPushPayload(Buffer.from('نان شما آماده است'), subscriptionKeys)
    const second = encryptWebPushPayload(Buffer.from('نان شما آماده است'), subscriptionKeys)
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false)
  })
})

describe('refusing a subscription that cannot work', () => {
  it('refuses a key that is not a point on P-256', () => {
    // RFC 8291's security considerations require this check: a peer key that is
    // not on the curve can be used to extract the private key.
    const offCurve = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 7)]).toString('base64url')
    expect(() =>
      encryptWebPushPayload(Buffer.from('x'), { p256dh: offCurve, auth: RFC8291.authSecret }),
    ).toThrow(WebPushCryptoError)
  })

  it('refuses a key of the wrong length rather than padding it', () => {
    expect(() =>
      encryptWebPushPayload(Buffer.from('x'), {
        p256dh: RFC8291.subscriptionPublicKey.slice(4),
        auth: RFC8291.authSecret,
      }),
    ).toThrow(/65 octets/)
    expect(() =>
      encryptWebPushPayload(Buffer.from('x'), {
        p256dh: RFC8291.subscriptionPublicKey,
        auth: RFC8291.authSecret.slice(4),
      }),
    ).toThrow(/16 octets/)
  })

  it('refuses a payload that would not fit in one record', () => {
    // RFC 8291 requires exactly one record, so the record size is a ceiling.
    expect(() =>
      encryptWebPushPayload(Buffer.alloc(MAX_PUSH_PLAINTEXT_OCTETS + 1), subscriptionKeys),
    ).toThrow(WebPushCryptoError)
    expect(() =>
      encryptWebPushPayload(Buffer.alloc(MAX_PUSH_PLAINTEXT_OCTETS), subscriptionKeys),
    ).not.toThrow()
  })
})

/**
 * RFC 8292 §2.4's example token, and the JWK it publishes for the key that
 * signed it. Verifying the RFC's own signature proves the signing input, the
 * encoding and the curve are the ones a push service will check against.
 */
const RFC8292 = {
  token:
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA',
  jwk: {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: 'DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc',
    y: 'F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs',
  },
  endpoint: 'https://push.example.net/p/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
  subject: 'mailto:push@example.com',
  expiry: 1_453_523_768,
}

describe('RFC 8292 application server identification', () => {
  it('verifies the specification’s own token against the key it published', () => {
    const [header, claims, signature] = RFC8292.token.split('.') as [string, string, string]
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`, 'utf8'),
        { key: createPublicKey({ key: RFC8292.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
  })

  it('signs a token the same way, which its own public key verifies', () => {
    const keys = generateVapidKeys()
    const authorization = vapidAuthorization({
      keys,
      subject: RFC8292.subject,
      endpoint: RFC8292.endpoint,
      now: new Date(RFC8292.expiry * 1000 - 12 * 60 * 60 * 1000),
      lifetimeSeconds: 12 * 60 * 60,
    })

    const token = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)
    expect(token).not.toBeNull()
    const [, jwt, publicKey] = token as unknown as [string, string, string]
    expect(publicKey).toBe(keys.publicKey)

    const [header, claims, signature] = jwt.split('.') as [string, string, string]
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    })
    // The audience is the push service's origin, not the endpoint. That is what
    // lets one token cover every subscription at a service and none anywhere
    // else.
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))).toEqual({
      aud: 'https://push.example.net',
      exp: RFC8292.expiry,
      sub: RFC8292.subject,
    })

    const point = Buffer.from(publicKey, 'base64url')
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`, 'utf8'),
        {
          key: createPublicKey({
            key: {
              kty: 'EC',
              crv: 'P-256',
              x: point.subarray(1, 33).toString('base64url'),
              y: point.subarray(33).toString('base64url'),
            },
            format: 'jwk',
          }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
  })

  /**
   * Two halves of two different pairs is the configuration mistake that cannot
   * be diagnosed from the other end: every push service answers 403 and none of
   * them says which half is wrong.
   */
  it('refuses a public key that does not belong to the private key', () => {
    const mine = generateVapidKeys()
    const theirs = generateVapidKeys()
    expect(() =>
      vapidAuthorization({
        keys: { publicKey: theirs.publicKey, privateKey: mine.privateKey },
        subject: RFC8292.subject,
        endpoint: RFC8292.endpoint,
        now: new Date(),
        lifetimeSeconds: 3600,
      }),
    ).toThrow(/does not belong/)
  })

  it('refuses a lifetime past the twenty-four hours the RFC allows', () => {
    // Past it, every push service returns 403 for every customer until somebody
    // notices.
    expect(() =>
      vapidAuthorization({
        keys: generateVapidKeys(),
        subject: RFC8292.subject,
        endpoint: RFC8292.endpoint,
        now: new Date(),
        lifetimeSeconds: 24 * 60 * 60 + 1,
      }),
    ).toThrow(WebPushCryptoError)
  })

  it('refuses a subject a push service operator could not contact', () => {
    expect(() =>
      vapidAuthorization({
        keys: generateVapidKeys(),
        subject: 'الو نون',
        endpoint: RFC8292.endpoint,
        now: new Date(),
        lifetimeSeconds: 3600,
      }),
    ).toThrow(/mailto:/)
  })
})
