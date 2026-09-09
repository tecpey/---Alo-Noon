import { describe, expect, it, vi } from 'vitest'

import type { Transporter } from 'nodemailer'

import { createSmtpAdapter } from './smtp'

function request(
  overrides: Partial<Parameters<ReturnType<typeof createSmtpAdapter>['send']>[0]> = {},
) {
  return {
    message: {
      to: [{ address: 'operator@example.test', name: 'اپراتور' }],
      subject: '[بحرانی] درگاه پرداخت از کار افتاده',
      body: 'دو درگاه ناسالم‌اند.',
    },
    sender: { address: 'no-reply@alonoon.test', name: 'الو نون' },
    credential: 'smtps://user:pass@mail.example.test:465',
    environment: 'TEST' as const,
    timeoutMs: 5_000,
    ...overrides,
  }
}

function transportThat(behaviour: { resolve?: unknown; reject?: unknown }): {
  transport: Transporter
  sendMail: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const sendMail = vi.fn(async () => {
    if (behaviour.reject !== undefined) throw behaviour.reject
    return behaviour.resolve
  })
  const close = vi.fn()
  return { transport: { sendMail, close } as unknown as Transporter, sendMail, close }
}

describe('the SMTP adapter', () => {
  it('sends the message and returns the server’s id for it', async () => {
    const { transport, sendMail, close } = transportThat({
      resolve: { messageId: '<abc@mail.example.test>' },
    })
    const adapter = createSmtpAdapter({ createTransportFor: () => transport })

    const result = await adapter.send(request())

    expect(result.outcome).toBe('SENT')
    expect(result.providerReference).toBe('<abc@mail.example.test>')
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[بحرانی] درگاه پرداخت از کار افتاده',
        text: 'دو درگاه ناسالم‌اند.',
        from: { address: 'no-reply@alonoon.test', name: 'الو نون' },
      }),
    )
    // Every send closes its own connection, so a burst of alerts cannot leave
    // sockets open behind it.
    expect(close).toHaveBeenCalled()
  })

  it('treats a 4xx as worth trying again and a 5xx as not', async () => {
    // SMTP says this itself. Getting it backwards means either hammering a
    // server that already refused, or dropping a message because the network
    // blinked.
    const transient = createSmtpAdapter({
      createTransportFor: () => transportThat({ reject: { responseCode: 451 } }).transport,
    })
    expect((await transient.send(request())).outcome).toBe('TRANSIENT_FAILURE')

    const permanent = createSmtpAdapter({
      createTransportFor: () => transportThat({ reject: { responseCode: 535 } }).transport,
    })
    expect((await permanent.send(request())).outcome).toBe('PERMANENT_FAILURE')
  })

  it('calls a refused mailbox rejected rather than a failure', async () => {
    const adapter = createSmtpAdapter({
      createTransportFor: () => transportThat({ reject: { responseCode: 550 } }).transport,
    })

    const result = await adapter.send(request())

    expect(result.outcome).toBe('REJECTED')
    expect(result.normalizedCode).toBe('SMTP_550')
  })

  it('retries a connection that never got a response code at all', async () => {
    // DNS, TCP, TLS and timeouts never produce one, and all of them are worth
    // another attempt.
    const adapter = createSmtpAdapter({
      createTransportFor: () => transportThat({ reject: { code: 'ETIMEDOUT' } }).transport,
    })

    const result = await adapter.send(request())

    expect(result.outcome).toBe('TRANSIENT_FAILURE')
    expect(result.normalizedCode).toBe('SMTP_ETIMEDOUT')
  })

  it('refuses a malformed credential permanently, rather than retrying it forever', async () => {
    const adapter = createSmtpAdapter()

    const result = await adapter.send(request({ credential: 'https://mail.example.test' }))

    expect(result.outcome).toBe('PERMANENT_FAILURE')
    expect(result.normalizedCode).toBe('SMTP_CREDENTIAL_MALFORMED')
  })

  it('never lets a plaintext session proceed without STARTTLS', async () => {
    // The password crosses the wire before the upgrade, so an opportunistic
    // default would silently send it in the clear to a server that had lost
    // its certificate.
    const captured: Record<string, unknown>[] = []
    const adapter = createSmtpAdapter({
      createTransportFor: (credential) => {
        const url = new URL(credential)
        captured.push({ secure: url.protocol === 'smtps:' })
        return transportThat({ resolve: { messageId: 'x' } }).transport
      },
    })

    await adapter.send(request({ credential: 'smtp://user:pass@mail.example.test:587' }))

    expect(captured[0]?.['secure']).toBe(false)
  })
})
