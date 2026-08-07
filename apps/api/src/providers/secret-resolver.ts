import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { ProviderSecretResolver } from '@alo-noon/domain'

/**
 * Resolves payment gateway credentials stored as `local-encrypted://` references.
 *
 * The database forbids `env://` for payment credentials by CHECK constraint -
 * only vault, aws-sm, gcp-sm, and local-encrypted are accepted - so a gateway
 * secret is never a plaintext environment variable. `local-encrypted` is the
 * intended option for a deployment without a managed secret manager: the
 * configured value is ciphertext, and the key that opens it is supplied
 * separately, so leaking the configuration alone does not leak the secret.
 *
 * AES-256-GCM. The stored blob is base64 of iv(12) || authTag(16) || ciphertext,
 * so tampering fails authentication instead of yielding a wrong-but-usable key.
 */
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const REFERENCE = /^local-encrypted:\/\/([A-Z][A-Z0-9_]{0,120})$/

export class PaymentSecretError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PaymentSecretError'
  }
}

export function parseEncryptionKey(rawKey: string | undefined): Buffer {
  if (!rawKey) throw new PaymentSecretError('PAYMENT_SECRET_KEY_MISSING')
  const key = Buffer.from(rawKey.trim(), 'base64')
  if (key.length !== KEY_BYTES) throw new PaymentSecretError('PAYMENT_SECRET_KEY_INVALID')
  return key
}

export function encryptPaymentSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new PaymentSecretError('PAYMENT_SECRET_KEY_INVALID')
  if (!plaintext) throw new PaymentSecretError('PAYMENT_SECRET_EMPTY')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decryptPaymentSecret(blob: string, key: Buffer): Buffer {
  const raw = Buffer.from(blob.trim(), 'base64')
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new PaymentSecretError('PAYMENT_SECRET_MALFORMED')
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new PaymentSecretError('PAYMENT_SECRET_AUTHENTICATION_FAILED')
  }
}

/**
 * `environment` supplies the encrypted blobs, keyed `PAYMENT_SECRET_<NAME>` for a
 * `local-encrypted://<NAME>` reference. The decryption key is separate and is
 * never one of those entries.
 */
/**
 * Builds the resolver from an optional raw key. With no key configured, every
 * resolution fails as unavailable rather than preventing startup, so an
 * environment without payments still boots and the payment route answers 503
 * instead of vanishing.
 */
export function createPaymentSecretResolver(
  environment: Readonly<Record<string, string | undefined>>,
  rawEncryptionKey: string | undefined,
): ProviderSecretResolver {
  if (!rawEncryptionKey) {
    return Object.freeze({
      async resolve() {
        throw new PaymentSecretError('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE')
      },
    })
  }
  return createLocalEncryptedPaymentSecretResolver(
    environment,
    parseEncryptionKey(rawEncryptionKey),
  )
}

export function createLocalEncryptedPaymentSecretResolver(
  environment: Readonly<Record<string, string | undefined>>,
  encryptionKey: Buffer,
): ProviderSecretResolver {
  return Object.freeze({
    async resolve(reference: string) {
      const match = REFERENCE.exec(reference)
      if (!match) throw new PaymentSecretError('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE')
      const blob = environment[`PAYMENT_SECRET_${match[1]!}`]
      if (!blob) throw new PaymentSecretError('PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE')
      const material = decryptPaymentSecret(blob, encryptionKey)
      return {
        material,
        dispose: () => material.fill(0),
      }
    },
  })
}
