import { DomainError } from './errors'
import type { RedactableValue } from './ai-redaction'

export interface AiAuditPolicyInput {
  readonly classification: 'PUBLIC' | 'INTERNAL' | 'TENANT_CONFIDENTIAL' | 'PII'
  readonly redactionStatus: 'NOT_REQUIRED' | 'REDACTED'
  readonly sequence: number
  readonly previousEventDigest?: string
  readonly payload: Readonly<Record<string, RedactableValue>>
}

const forbiddenKey =
  /(?:raw.?prompt|raw.?conversation|raw.?tool.?output|password|passwd|secret|token|credential|api.?key|private.?key|authorization|cookie|session)/i
const piiKey =
  /(?:email|phone|mobile|address|postal|latitude|longitude|first.?name|last.?name|full.?name)/i
const credentialValue = /(?:bearer\s+[a-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
const redacted = '[REDACTED]'

function assertPayloadSafe(value: RedactableValue, path: string): void {
  if (typeof value === 'string' && credentialValue.test(value)) {
    throw new DomainError('AI_AUDIT_POLICY_VIOLATION', 'Credential material is forbidden', { path })
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPayloadSafe(item, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = path ? `${path}.${key}` : key
      if (forbiddenKey.test(key)) {
        throw new DomainError(
          'AI_AUDIT_POLICY_VIOLATION',
          'Raw or secret-bearing fields are forbidden',
          {
            path: nestedPath,
          },
        )
      }
      if (piiKey.test(key) && nested !== redacted) {
        throw new DomainError(
          'AI_AUDIT_POLICY_VIOLATION',
          'PII fields must be redacted before audit',
          {
            path: nestedPath,
          },
        )
      }
      assertPayloadSafe(nested, nestedPath)
    }
  }
}

export function assertAiAuditEventPolicy(input: Readonly<AiAuditPolicyInput>): void {
  assertPayloadSafe(input.payload, 'payload')

  if (input.classification === 'PII' && input.redactionStatus !== 'REDACTED') {
    throw new DomainError(
      'AI_AUDIT_POLICY_VIOLATION',
      'PII audit payloads must be marked as redacted',
    )
  }
  if (input.sequence === 1 && input.previousEventDigest !== undefined) {
    throw new DomainError(
      'AI_AUDIT_POLICY_VIOLATION',
      'The first audit event cannot have a predecessor',
    )
  }
  if (input.sequence > 1 && input.previousEventDigest === undefined) {
    throw new DomainError(
      'AI_AUDIT_POLICY_VIOLATION',
      'Subsequent audit events require a predecessor digest',
    )
  }
}
