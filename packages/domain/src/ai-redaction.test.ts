import { describe, expect, it } from 'vitest'

import { redactAiTelemetry } from './ai-redaction'
import { DomainError } from './errors'

describe('AI telemetry redaction', () => {
  it('recursively redacts PII while retaining operational evidence', () => {
    expect(
      redactAiTelemetry({
        incidentId: 'incident-1',
        customer: { phone: '+989111111111', status: 'ACTIVE' },
        samples: [{ email: 'person@example.com', latencyMs: 42 }],
      }),
    ).toEqual({
      value: {
        incidentId: 'incident-1',
        customer: { phone: '[REDACTED]', status: 'ACTIVE' },
        samples: [{ email: '[REDACTED]', latencyMs: 42 }],
      },
      redactedPaths: ['customer.phone', 'samples[0].email'],
      classification: 'PII',
      redactionStatus: 'REDACTED',
    })
  })

  it.each(['apiKey', 'accessToken', 'refresh_token', 'clientSecret', 'credentials'])(
    'fails closed for secret field %s',
    (key) => {
      expect(() => redactAiTelemetry({ [key]: 'opaque-value' })).toThrowError(DomainError)
    },
  )

  it('fails closed for credential-shaped values', () => {
    expect(() => redactAiTelemetry({ header: 'Bearer abc.def.ghi' })).toThrowError(DomainError)
  })

  it('does not claim redaction when no sensitive field exists', () => {
    expect(redactAiTelemetry({ service: 'api', statusCode: 503 })).toMatchObject({
      redactedPaths: [],
      classification: 'INTERNAL',
      redactionStatus: 'NOT_REQUIRED',
    })
  })
})
