import { DomainError } from './errors'

export type RedactableScalar = string | number | boolean | null
export interface RedactableObject {
  readonly [key: string]: RedactableValue
}
export type RedactableValue = RedactableScalar | ReadonlyArray<RedactableValue> | RedactableObject

export interface RedactionResult {
  value: Readonly<Record<string, RedactableValue>>
  redactedPaths: ReadonlyArray<string>
  classification: 'PUBLIC' | 'INTERNAL' | 'TENANT_CONFIDENTIAL' | 'PII'
  redactionStatus: 'NOT_REQUIRED' | 'REDACTED'
}

const blockedKey =
  /(?:password|passwd|secret|token|api.?key|private.?key|authorization|cookie|session)/i
const piiKey =
  /(?:email|phone|mobile|address|postal|latitude|longitude|first.?name|last.?name|full.?name)/i
const credentialValue = /(?:bearer\s+[a-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
const redacted = '[REDACTED]'

function isRedactableObject(value: RedactableValue): value is RedactableObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function redactAiTelemetry(
  input: Readonly<Record<string, RedactableValue>>,
): Readonly<RedactionResult> {
  const paths: string[] = []
  let containsPii = false

  function visit(value: RedactableValue, path: string): RedactableValue {
    if (typeof value === 'string' && credentialValue.test(value)) {
      throw new DomainError(
        'AI_TELEMETRY_BLOCKED',
        'Credential material cannot enter AI telemetry',
        {
          path,
        },
      )
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`))
    if (isRedactableObject(value)) {
      const result: Record<string, RedactableValue> = {}
      for (const [key, nested] of Object.entries(value)) {
        const nestedPath = path ? `${path}.${key}` : key
        if (blockedKey.test(key)) {
          throw new DomainError('AI_TELEMETRY_BLOCKED', 'Secret-bearing fields are forbidden', {
            path: nestedPath,
          })
        }
        if (piiKey.test(key)) {
          result[key] = redacted
          paths.push(nestedPath)
          containsPii = true
        } else {
          result[key] = visit(nested, nestedPath)
        }
      }
      return result
    }
    return value
  }

  const value = visit(input, '')
  if (!isRedactableObject(value)) {
    throw new DomainError('AI_TELEMETRY_BLOCKED', 'AI telemetry root must be an object')
  }

  return Object.freeze({
    value: Object.freeze(value),
    redactedPaths: Object.freeze(paths),
    classification: containsPii ? 'PII' : 'INTERNAL',
    redactionStatus: paths.length > 0 ? 'REDACTED' : 'NOT_REQUIRED',
  })
}
