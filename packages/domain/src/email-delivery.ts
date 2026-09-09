import { DomainError } from './errors'

/**
 * The contract an email service must satisfy, and how one is chosen.
 *
 * Shaped like the SMS delivery SPI next to it, for the reason that shape was
 * chosen there: an adapter is a pure translator between our vocabulary and a
 * vendor's, holding no state and reading no configuration of its own. Which
 * service is used, whether it is trusted, and what credential it resolves are
 * decisions made outside the adapter and handed to it.
 *
 * The deliberate difference from SMS: there is no circuit breaker here. An OTP
 * that arrives late is a customer who cannot sign in, so that path trips fast
 * and fails over. An operator alert that arrives late is still useful, and an
 * alert suppressed because the mail server was briefly slow is the one you
 * needed. Retries are the outbox's job; this layer just reports what happened.
 */
export const EMAIL_ADAPTER_SPI_VERSION = 1 as const

export type EmailEnvironment = 'TEST' | 'PRODUCTION'

export interface EmailRecipient {
  readonly address: string
  readonly name?: string
}

export interface EmailMessage {
  readonly to: readonly EmailRecipient[]
  readonly subject: string
  /**
   * Plain text only, and that is a decision rather than a gap.
   *
   * These messages are read at 4am by someone deciding whether to get out of
   * bed. HTML would add a rendering surface, a spam signal, and a way for a
   * message to look fine in one client and empty in another — for no gain over
   * a subject line and six lines of text.
   */
  readonly body: string
}

export interface EmailSendRequest {
  readonly message: EmailMessage
  readonly sender: EmailRecipient
  /** Resolved outside the adapter, from the configuration's reference. */
  readonly credential: string
  readonly environment: EmailEnvironment
  readonly timeoutMs: number
}

export type EmailSendOutcome = 'SENT' | 'REJECTED' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE'

export interface EmailSendResult {
  readonly outcome: EmailSendOutcome
  /** The provider's own id for the message, when it gives one. */
  readonly providerReference: string | null
  /** A stable, non-secret code an operator can act on. */
  readonly normalizedCode: string | null
}

export interface EmailProvider {
  readonly code: string
  readonly adapterVersion: string
  readonly spiVersion: typeof EMAIL_ADAPTER_SPI_VERSION
  /** Test adapters are never selectable in a PRODUCTION environment. */
  readonly testOnly?: boolean
  send(request: EmailSendRequest): Promise<EmailSendResult>
}

export interface EmailAdapterIdentity {
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: typeof EMAIL_ADAPTER_SPI_VERSION
  readonly testOnly: boolean
}

export interface EmailRegistry {
  resolve(input: {
    providerCode: string
    adapterVersion: string
    adapterSpiVersion: number
    environment: EmailEnvironment
  }): EmailProvider
  identities(): readonly EmailAdapterIdentity[]
}

export interface EmailSelectionCandidate {
  readonly id: string
  readonly providerCode: string
  readonly adapterVersion: string
  readonly adapterSpiVersion: number
  readonly environment: EmailEnvironment
  readonly enabled: boolean
  readonly isDefault: boolean
  readonly priority: number
  readonly healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
}

/**
 * Which configuration to use, or none.
 *
 * Returns `undefined` rather than throwing when nothing qualifies, because
 * "this tenant has no email" is an ordinary state and not an error: a tenant
 * that has not configured email should simply not be sent alerts, and the
 * caller decides what to do about that.
 *
 * UNKNOWN is not selectable. A configuration that has never been attested is
 * one nobody has proved can send, and discovering that during an incident —
 * when the alert is the thing that would have told you — is the worst possible
 * moment.
 */
export function selectEmailConfiguration(
  candidates: readonly EmailSelectionCandidate[],
  environment: EmailEnvironment,
): EmailSelectionCandidate | undefined {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.environment === environment &&
      candidate.enabled &&
      // DEGRADED is still selectable: it means slow or partially failing, and a
      // late alert beats no alert. UNHEALTHY and UNKNOWN are not.
      (candidate.healthStatus === 'HEALTHY' || candidate.healthStatus === 'DEGRADED'),
  )
  if (eligible.length === 0) return undefined

  // The default first, then by priority, then by health — a healthy service
  // ahead of a degraded one at the same priority. Ties break on id so the
  // choice is stable across calls rather than depending on row order.
  const ranked = [...eligible].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
    if (left.priority !== right.priority) return left.priority - right.priority
    const health = healthRank(left.healthStatus) - healthRank(right.healthStatus)
    if (health !== 0) return health
    return left.id.localeCompare(right.id)
  })
  return ranked[0]
}

function healthRank(status: EmailSelectionCandidate['healthStatus']): number {
  return status === 'HEALTHY' ? 0 : 1
}

export function createEmailRegistry(providers: readonly EmailProvider[]): EmailRegistry {
  const byKey = new Map<string, EmailProvider>()
  const identities: EmailAdapterIdentity[] = []

  for (const provider of providers) {
    if (provider.spiVersion !== EMAIL_ADAPTER_SPI_VERSION) {
      throw new DomainError(
        'EMAIL_ADAPTER_SPI_UNSUPPORTED',
        `Adapter ${provider.code} implements SPI ${String(provider.spiVersion)}, not ${EMAIL_ADAPTER_SPI_VERSION}`,
      )
    }
    const key = adapterKey(provider.code, provider.adapterVersion)
    if (byKey.has(key)) {
      throw new DomainError(
        'EMAIL_ADAPTER_DUPLICATE',
        `Two adapters claim ${provider.code} at version ${provider.adapterVersion}`,
      )
    }
    byKey.set(key, provider)
    identities.push({
      providerCode: provider.code,
      adapterVersion: provider.adapterVersion,
      adapterSpiVersion: EMAIL_ADAPTER_SPI_VERSION,
      testOnly: provider.testOnly === true,
    })
  }

  return {
    resolve(input) {
      if (input.adapterSpiVersion !== EMAIL_ADAPTER_SPI_VERSION) {
        throw new DomainError(
          'EMAIL_ADAPTER_SPI_UNSUPPORTED',
          `Configuration asks for SPI ${input.adapterSpiVersion}, which this build does not implement`,
        )
      }
      const provider = byKey.get(adapterKey(input.providerCode, input.adapterVersion))
      if (!provider) {
        throw new DomainError(
          'EMAIL_ADAPTER_UNAVAILABLE',
          `No adapter serves ${input.providerCode} at version ${input.adapterVersion}`,
        )
      }
      // A test adapter reaching production would mean alerts silently going
      // nowhere while the panel showed a healthy service.
      if (provider.testOnly === true && input.environment === 'PRODUCTION') {
        throw new DomainError(
          'EMAIL_ADAPTER_UNAVAILABLE',
          `Adapter ${provider.code} is test-only and cannot serve PRODUCTION`,
        )
      }
      return provider
    },
    identities() {
      return Object.freeze([...identities])
    },
  }
}

function adapterKey(providerCode: string, adapterVersion: string): string {
  return `${providerCode}@${adapterVersion}`
}
