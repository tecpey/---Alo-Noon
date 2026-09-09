import { createTransport, type Transporter } from 'nodemailer'

import {
  EMAIL_ADAPTER_SPI_VERSION,
  type EmailProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from '@alo-noon/domain'

/**
 * SMTP, because it is the one protocol every mail service speaks.
 *
 * A vendor API adapter would be a guess about which service this tenant ends up
 * buying — and in Iran that decision is often made late, sometimes in favour of
 * a mail server the business already runs. SMTP works with all of them,
 * including the one they already have, and does not tie an alerting path to a
 * vendor relationship that may not survive the pilot.
 *
 * The connection details come from the credential the configuration names, so
 * changing mail providers is a configuration change rather than a deployment.
 * The credential is a URL:
 *
 *     smtps://user:password@mail.example.com:465
 *     smtp://user:password@mail.example.com:587
 *
 * `smtps://` means TLS from the first byte (usually port 465). `smtp://` starts
 * plaintext and upgrades with STARTTLS, which is required rather than optional
 * here: a server that will not upgrade gets no message, because an SMTP session
 * carries the password in the clear before the upgrade.
 */
const SMTP_ADAPTER_VERSION = '1.0.0'

export interface SmtpAdapterOptions {
  /**
   * Injected so a test can assert what would have been sent without a mail
   * server. Production passes nothing and gets a real transport.
   */
  readonly createTransportFor?: (credential: string, timeoutMs: number) => Transporter
}

export function createSmtpAdapter(options: SmtpAdapterOptions = {}): EmailProvider {
  const build = options.createTransportFor ?? defaultTransport

  return {
    code: 'SMTP',
    adapterVersion: SMTP_ADAPTER_VERSION,
    spiVersion: EMAIL_ADAPTER_SPI_VERSION,

    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      let transport: Transporter
      try {
        transport = build(request.credential, request.timeoutMs)
      } catch {
        // A malformed credential is a configuration mistake, not a bad night on
        // the network: retrying it forever would never succeed.
        return {
          outcome: 'PERMANENT_FAILURE',
          providerReference: null,
          normalizedCode: 'SMTP_CREDENTIAL_MALFORMED',
        }
      }

      try {
        const info = await transport.sendMail({
          from: { address: request.sender.address, name: request.sender.name ?? '' },
          to: request.message.to.map((recipient) => ({
            address: recipient.address,
            name: recipient.name ?? '',
          })),
          subject: request.message.subject,
          text: request.message.body,
        })
        return {
          outcome: 'SENT',
          providerReference: typeof info.messageId === 'string' ? info.messageId : null,
          normalizedCode: null,
        }
      } catch (error) {
        return classify(error)
      } finally {
        // Each send opens and closes its own connection. Alerts are rare and
        // bursty; a pooled connection held open between them is one more thing
        // to go stale unnoticed, and the cost of a handshake is irrelevant when
        // the alternative is nobody being told.
        transport.close()
      }
    },
  }
}

function defaultTransport(credential: string, timeoutMs: number): Transporter {
  const url = new URL(credential)
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new Error('An SMTP credential must be an smtp:// or smtps:// URL')
  }
  const secure = url.protocol === 'smtps:'

  return createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    // On a plaintext port, STARTTLS is required rather than opportunistic. The
    // opportunistic default would silently send the password in the clear
    // against a server that had lost its certificate.
    ...(secure ? {} : { requireTLS: true }),
    ...(url.username
      ? {
          auth: {
            user: decodeURIComponent(url.username),
            pass: decodeURIComponent(url.password),
          },
        }
      : {}),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  })
}

/**
 * Which failures are worth trying again.
 *
 * SMTP says this itself: 4xx means "not now", 5xx means "not ever, as asked".
 * Getting this wrong in the retryable direction means hammering a server that
 * has already refused; getting it wrong the other way means dropping a message
 * because the network blinked.
 */
function classify(error: unknown): EmailSendResult {
  const responseCode = readNumber(error, 'responseCode')
  const code = readString(error, 'code')

  if (typeof responseCode === 'number') {
    if (responseCode >= 500) {
      return {
        outcome: responseCode === 550 || responseCode === 553 ? 'REJECTED' : 'PERMANENT_FAILURE',
        providerReference: null,
        normalizedCode: `SMTP_${responseCode}`,
      }
    }
    return {
      outcome: 'TRANSIENT_FAILURE',
      providerReference: null,
      normalizedCode: `SMTP_${responseCode}`,
    }
  }

  // No response code at all means the conversation never got far enough to have
  // one — DNS, TCP, TLS, or a timeout. All of those are worth another attempt.
  return {
    outcome: 'TRANSIENT_FAILURE',
    providerReference: null,
    normalizedCode: code ? `SMTP_${code}` : 'SMTP_UNREACHABLE',
  }
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const read = Reflect.get(value, key)
  return typeof read === 'number' ? read : undefined
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const read = Reflect.get(value, key)
  return typeof read === 'string' ? read : undefined
}
