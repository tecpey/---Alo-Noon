import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  What the web server tells the API about who is asking.

  Every storefront call reaches the API from this server's loopback address, so
  the API can only tell two shoppers apart by what is forwarded here. Without
  X-Forwarded-For, 600 anonymous page views on the production bundle spent one
  shared rate-limit budget and the shop answered 429 to everyone — and the
  login-code abuse count would have treated the whole city as one person.
*/

const incoming = new Headers()
let sessionCookie: string | undefined

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({
  headers: async () => incoming,
  cookies: async () => ({
    get: (name: string) =>
      name === 'alo_session' && sessionCookie !== undefined
        ? { name, value: sessionCookie }
        : undefined,
  }),
}))

const { upstreamHeaders } = await import('./api-core')

describe('upstreamHeaders', () => {
  beforeEach(() => {
    for (const name of [...incoming.keys()]) incoming.delete(name)
    sessionCookie = undefined
  })

  it('passes on the client address nginx gave this server, unchanged', async () => {
    // Unchanged matters: nginx appended the address it saw to whatever the
    // client sent, and the API picks the right-most untrusted entry. Rebuilding
    // or trimming the list here would hand that choice to the client.
    incoming.set('x-forwarded-for', '198.51.100.9, 203.0.113.5')

    expect((await upstreamHeaders())['x-forwarded-for']).toBe('198.51.100.9, 203.0.113.5')
  })

  it('invents no address when none arrived', async () => {
    // Development without nginx: the API falls back to the socket address,
    // which is the honest answer there.
    expect(await upstreamHeaders()).not.toHaveProperty('x-forwarded-for')
  })

  it('still forwards only the session cookie, whatever else the browser sent', async () => {
    incoming.set('cookie', 'alo_session=abc; tracking=xyz')
    sessionCookie = 'abc'

    expect((await upstreamHeaders())['cookie']).toBe('alo_session=abc')
  })
})
