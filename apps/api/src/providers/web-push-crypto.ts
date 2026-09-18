import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto'

/**
 * The Web Push protocol's cryptography, and nothing else.
 *
 * Separated from the adapter beside it because these are the only lines in this
 * repository whose correctness cannot be judged by reading them. Encryption
 * that is subtly wrong does not throw and does not log: the push service
 * accepts the request, returns 201, and the browser silently discards a payload
 * it could not open. The customer is simply never told their bread arrived, and
 * nothing anywhere says why.
 *
 * So the test beside this file is not a test of this code's behaviour. It is
 * RFC 8291's own worked example — every intermediate value, key by key, down to
 * the final record — and RFC 8292's own signed token, verified against the
 * public key the RFC publishes for it. If this file reproduces those byte for
 * byte it is doing what Chrome, Firefox and Safari implement, and if it does
 * not, no amount of it looking right matters.
 *
 * ## What the two RFCs each do
 *
 * RFC 8291 is why the push service cannot read the message. The browser hands
 * its page a subscription containing a public key and a shared secret; this
 * server does ECDH against that key with a throwaway key pair, folds in the
 * secret, and encrypts with AES-128-GCM under RFC 8188's `aes128gcm` content
 * coding. Google or Mozilla or Apple forward a blob they cannot open.
 *
 * RFC 8292 (VAPID) is why the push service will talk to us. It is a signed JWT
 * that identifies the application server and is bound to the push service's own
 * origin, so a token stolen from one service cannot be replayed at another.
 *
 * Neither of them authenticates the *customer*. Anyone holding the endpoint URL
 * can post to it; what they cannot do is produce something the browser will
 * decrypt. That is the security this file provides, and the reason the endpoint
 * is treated as a credential everywhere it is stored.
 */

/** Uncompressed P-256 point: the 0x04 prefix and two 32-octet coordinates. */
const P256_POINT_OCTETS = 65
const P256_SCALAR_OCTETS = 32
const AUTH_SECRET_OCTETS = 16
const SALT_OCTETS = 16

/**
 * The record size written into the content coding header.
 *
 * RFC 8030 requires a push service to accept at least 4096 octets, and RFC 8291
 * requires exactly one record, so the whole message is this one record and the
 * size is the ceiling rather than a chunking parameter.
 */
const RECORD_SIZE = 4096
const HEADER_OCTETS = SALT_OCTETS + 4 + 1 + P256_POINT_OCTETS
const GCM_TAG_OCTETS = 16
/** The delimiter octet costs one more. */
export const MAX_PUSH_PLAINTEXT_OCTETS = RECORD_SIZE - HEADER_OCTETS - 1 - GCM_TAG_OCTETS

export class WebPushCryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WebPushCryptoError'
  }
}

export interface WebPushSubscriptionKeys {
  /** base64url of the browser's uncompressed P-256 public key. */
  readonly p256dh: string
  /** base64url of the browser's 16-octet authentication secret. */
  readonly auth: string
}

export interface EncryptOptions {
  /**
   * Supplied only by the test that reproduces RFC 8291's example.
   *
   * Every real send generates both. A reused salt with a reused key pair
   * reuses the AES-GCM nonce, which is the failure that loses the key rather
   * than the message.
   */
  readonly salt?: Buffer
  readonly senderPrivateKey?: Buffer
}

/**
 * One push message, encrypted to one subscription.
 *
 * Returns the complete `aes128gcm` body: RFC 8188's header — salt, record size,
 * and the sender's public key as the `keyid` — followed by the single record.
 *
 * The plaintext is not padded. RFC 8188 allows it and it would hide the length
 * of each message from the push service, which can otherwise tell "your bread
 * is ready" from "your order was delivered" by size alone. It is left off
 * because the leak is small against what the push service already sees — which
 * customer, from which server, at what hour — and because padding is the part
 * of the format least exercised by real browsers. A padding bug fails the way
 * everything here fails: silently, on somebody's phone, with a 201 in our logs.
 */
export function encryptWebPushPayload(
  plaintext: Buffer,
  keys: WebPushSubscriptionKeys,
  options: EncryptOptions = {},
): Buffer {
  if (plaintext.byteLength > MAX_PUSH_PLAINTEXT_OCTETS) {
    throw new WebPushCryptoError(
      'PUSH_PAYLOAD_TOO_LARGE',
      `A push payload may not exceed ${MAX_PUSH_PLAINTEXT_OCTETS} octets`,
    )
  }

  const uaPublic = decodeExactly(keys.p256dh, P256_POINT_OCTETS, 'PUSH_SUBSCRIPTION_KEY_INVALID')
  const authSecret = decodeExactly(keys.auth, AUTH_SECRET_OCTETS, 'PUSH_SUBSCRIPTION_AUTH_INVALID')

  const sender = createECDH('prime256v1')
  if (options.senderPrivateKey) sender.setPrivateKey(options.senderPrivateKey)
  else sender.generateKeys()
  const asPublic = sender.getPublicKey()

  let sharedSecret: Buffer
  try {
    sharedSecret = sender.computeSecret(uaPublic)
  } catch {
    // RFC 8291's security considerations require the peer's key to be verified
    // as a point on P-256. `computeSecret` performs that check, and a key that
    // fails it is a subscription that was corrupted or forged rather than an
    // error worth retrying.
    throw new WebPushCryptoError(
      'PUSH_SUBSCRIPTION_KEY_INVALID',
      'The subscription key is not a point on P-256',
    )
  }

  const salt = options.salt ?? randomBytes(SALT_OCTETS)
  if (salt.byteLength !== SALT_OCTETS) {
    throw new WebPushCryptoError('PUSH_SALT_INVALID', 'A push salt is sixteen octets')
  }

  // RFC 8291 §3.3: the ECDH secret and the subscription's authentication secret
  // are combined, and the info string binds the result to *both* public keys so
  // a key substituted by the push service produces a different content
  // encryption key rather than a readable message.
  const prkKey = hmac(authSecret, sharedSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic])
  const ikm = expand(prkKey, keyInfo, 32)

  // RFC 8188 §2.2 from here: an ordinary HKDF over the salt in the header.
  const prk = hmac(salt, ikm)
  const contentEncryptionKey = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  // No exclusive-or with a record sequence number: there is one record and its
  // sequence number is zero.
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)

  const header = Buffer.alloc(HEADER_OCTETS)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, SALT_OCTETS)
  header.writeUInt8(asPublic.byteLength, SALT_OCTETS + 4)
  asPublic.copy(header, SALT_OCTETS + 5)

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce)
  // 0x02 is RFC 8188's delimiter for the last record. 0x01 would tell the
  // browser to expect another one and it would wait for a record that never
  // comes.
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.of(2)])),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  return Buffer.concat([header, record])
}

export interface VapidKeyPair {
  /** base64url of the uncompressed P-256 public key, 65 octets. */
  readonly publicKey: string
  /** base64url of the private scalar, 32 octets. */
  readonly privateKey: string
}

export interface VapidTokenInput {
  readonly keys: VapidKeyPair
  /** A `mailto:` or `https:` URI a push service operator could reach us at. */
  readonly subject: string
  /** The push endpoint this token will be sent to. */
  readonly endpoint: string
  readonly now: Date
  /** How long the token is good for. RFC 8292 caps this at 24 hours. */
  readonly lifetimeSeconds: number
}

const MAX_VAPID_LIFETIME_SECONDS = 24 * 60 * 60

/**
 * The `Authorization: vapid` header for one request.
 *
 * `aud` is the push service's origin and not the endpoint path, which is what
 * makes one token usable for every subscription at the same service and useless
 * at any other. `exp` is checked against RFC 8292's 24-hour ceiling here rather
 * than trusted from configuration: past it every push service returns 403, for
 * every customer, until somebody notices.
 */
export function vapidAuthorization(input: VapidTokenInput): string {
  if (
    !Number.isFinite(input.lifetimeSeconds) ||
    input.lifetimeSeconds <= 0 ||
    input.lifetimeSeconds > MAX_VAPID_LIFETIME_SECONDS
  ) {
    throw new WebPushCryptoError(
      'VAPID_LIFETIME_INVALID',
      'A VAPID token lives between one second and twenty-four hours',
    )
  }
  if (!/^(mailto:|https:\/\/)/.test(input.subject)) {
    throw new WebPushCryptoError(
      'VAPID_SUBJECT_INVALID',
      'A VAPID subject is a mailto: or https: URI',
    )
  }

  let audience: string
  try {
    audience = new URL(input.endpoint).origin
  } catch {
    throw new WebPushCryptoError('PUSH_ENDPOINT_INVALID', 'The push endpoint is not a URL')
  }

  const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'))
  const claims = base64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(input.now.getTime() / 1000) + input.lifetimeSeconds,
        sub: input.subject,
      }),
      'utf8',
    ),
  )
  const signingInput = `${header}.${claims}`

  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: vapidSigningKey(input.keys),
    // JWS wants the two coordinates raw and fixed-width. Node's default is DER,
    // which every push service rejects — and rejects as a bad signature, so the
    // symptom is "our keys are wrong" rather than "our encoding is wrong".
    dsaEncoding: 'ieee-p1363',
  })

  return `vapid t=${signingInput}.${base64url(signature)}, k=${input.keys.publicKey}`
}

/**
 * The private key, with the configured public key checked against it.
 *
 * Worth the few lines: a deployment that pastes the public key of one pair and
 * the private key of another gets a 403 from every push service, for every
 * customer, forever, and the 403 says nothing about which half is wrong. Here
 * it is a startup-shaped failure with a name.
 */
function vapidSigningKey(keys: VapidKeyPair) {
  const privateScalar = decodeExactly(keys.privateKey, P256_SCALAR_OCTETS, 'VAPID_PRIVATE_INVALID')
  const publicPoint = decodeExactly(keys.publicKey, P256_POINT_OCTETS, 'VAPID_PUBLIC_INVALID')

  const ecdh = createECDH('prime256v1')
  try {
    ecdh.setPrivateKey(privateScalar)
  } catch {
    throw new WebPushCryptoError(
      'VAPID_PRIVATE_INVALID',
      'The VAPID private key is not a P-256 scalar',
    )
  }
  if (!ecdh.getPublicKey().equals(publicPoint)) {
    throw new WebPushCryptoError(
      'VAPID_KEY_PAIR_MISMATCH',
      'The VAPID public key does not belong to the private key',
    )
  }

  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: base64url(privateScalar),
      x: base64url(publicPoint.subarray(1, 33)),
      y: base64url(publicPoint.subarray(33)),
    },
    format: 'jwk',
  })
}

/**
 * A fresh VAPID pair, for an operator setting a deployment up.
 *
 * Here rather than in a script so the shape of what goes into configuration is
 * defined next to the code that reads it.
 */
export function generateVapidKeys(): VapidKeyPair {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: base64url(ecdh.getPublicKey()),
    privateKey: base64url(ecdh.getPrivateKey()),
  }
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/**
 * HKDF-Expand for one block.
 *
 * Every length these RFCs ask for is at most 32 octets, so the counter never
 * passes 0x01 and the loop the general form needs would be a loop that runs
 * once. Written out so it can be read against the pseudocode in RFC 8291 §3.4.
 */
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.of(1)])).subarray(0, length)
}

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

/**
 * base64url in, an exact number of octets out.
 *
 * `Buffer.from` never throws: given something that is not base64 it returns
 * whatever prefix it could read, so the length check is the whole check. A key
 * accepted one octet short is a subscription that is stored, sent to, and
 * discarded in silence.
 */
function decodeExactly(value: string, octets: number, code: string): Buffer {
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== octets) {
    throw new WebPushCryptoError(code, `Expected ${octets} octets, decoded ${decoded.byteLength}`)
  }
  return decoded
}
