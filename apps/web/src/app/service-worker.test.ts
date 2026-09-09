import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * The service worker's policy, driven rather than read.
 *
 * A worker sits between a customer and every answer the shop gives them, and
 * this shop's answers are prices, baskets, wallet balances and payment
 * verdicts. The rule it exists to keep is that none of those is ever served
 * from a phone's storage — and a rule that important should not rest on
 * somebody reading the file and agreeing with it.
 *
 * So the real `public/sw.js` is loaded into a sandbox with a fake cache and a
 * fake network, its handlers are driven with the requests a shop actually
 * makes, and what it does is asserted. If somebody later adds `/api` to the
 * cacheable list, or turns navigations into cache-first "for speed", these fail.
 */
const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')

const ORIGIN = 'https://alonoon.test'

interface Harness {
  listeners: Map<string, (event: FakeEvent) => void>
  cache: Map<string, string>
  deletedCaches: string[]
  cacheNames: string[]
  fetched: string[]
  /** Requests the network will refuse, simulating no connection. */
  offline: boolean
  /** Per-path overrides for what the fake network answers with. */
  networkAnswers: Record<string, { ok: boolean; type?: string }>
  skipWaitingCalled: boolean
  claimCalled: boolean
}

interface FakeEvent {
  request: FakeRequest
  respondWith(response: unknown): void
  waitUntil(promise: Promise<unknown>): void
}

interface FakeRequest {
  url: string
  method: string
  mode: string
}

function load(overrides: Partial<Harness> = {}): {
  harness: Harness
  dispatch: (type: string, event: Partial<FakeEvent>) => Promise<unknown>
  request: (url: string, init?: { method?: string; mode?: string }) => Promise<unknown | undefined>
} {
  const harness: Harness = {
    listeners: new Map(),
    cache: new Map(),
    deletedCaches: [],
    cacheNames: [],
    fetched: [],
    offline: false,
    networkAnswers: {},
    skipWaitingCalled: false,
    claimCalled: false,
    ...overrides,
  }

  const cacheObject = {
    add: async (input: { url?: string } | string) => {
      const url = typeof input === 'string' ? input : (input.url ?? '')
      if (harness.offline) throw new Error('offline')
      harness.fetched.push(url)
      harness.cache.set(new URL(url, ORIGIN).pathname, `precached:${url}`)
    },
    put: async (request: FakeRequest, response: unknown) => {
      harness.cache.set(new URL(request.url, ORIGIN).pathname, `cached:${String(response)}`)
    },
  }

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: FakeEvent) => void) => {
        harness.listeners.set(type, handler)
      },
      skipWaiting: async () => {
        harness.skipWaitingCalled = true
      },
      clients: {
        claim: async () => {
          harness.claimCalled = true
        },
      },
    },
    caches: {
      open: async () => cacheObject,
      keys: async () => harness.cacheNames,
      delete: async (name: string) => {
        harness.deletedCaches.push(name)
        return true
      },
      match: async (input: FakeRequest | string) => {
        const url = typeof input === 'string' ? input : input.url
        return harness.cache.get(new URL(url, ORIGIN).pathname)
      },
    },
    fetch: async (input: FakeRequest | string) => {
      const url = typeof input === 'string' ? input : input.url
      if (harness.offline) throw new Error('network unreachable')
      harness.fetched.push(url)
      const answer = harness.networkAnswers[new URL(url, ORIGIN).pathname]
      return {
        ok: answer?.ok ?? true,
        type: answer?.type ?? 'basic',
        clone: () => `network:${url}`,
        body: `network:${url}`,
      }
    },
    Request: class {
      url: string
      method = 'GET'
      mode = 'no-cors'
      constructor(url: string) {
        this.url = url
      }
    },
    Response: class {
      constructor(
        readonly body: string,
        readonly init?: unknown,
      ) {}
    },
    URL,
    console,
  }

  runInNewContext(source, sandbox)

  const dispatch = async (type: string, event: Partial<FakeEvent>) => {
    const handler = harness.listeners.get(type)
    if (!handler) throw new Error(`no ${type} listener registered`)
    let responded: unknown
    let waited: Promise<unknown> | undefined
    handler({
      request: { url: `${ORIGIN}/`, method: 'GET', mode: 'navigate' },
      ...event,
      respondWith: (response: unknown) => {
        responded = response
      },
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise
      },
    } as FakeEvent)
    if (waited) await waited
    return responded ? await responded : undefined
  }

  const request = async (url: string, init: { method?: string; mode?: string } = {}) =>
    dispatch('fetch', {
      request: {
        url: url.startsWith('http') ? url : `${ORIGIN}${url}`,
        method: init.method ?? 'GET',
        mode: init.mode ?? 'no-cors',
      },
    })

  return { harness, dispatch, request }
}

describe('what the service worker refuses to hold', () => {
  it('never caches a page, however many times it is asked for', async () => {
    const { harness, request } = load()

    for (let visit = 0; visit < 3; visit++) {
      await request('/products/barbari', { mode: 'navigate' })
      await request('/wallet', { mode: 'navigate' })
      await request('/payments/result', { mode: 'navigate' })
    }

    // Every one of those went to the network, every time.
    expect(harness.fetched.filter((url) => url.includes('/wallet'))).toHaveLength(3)
    // And not one of them was kept. A page here is a price, a balance or a
    // payment verdict, and the cached copy of any of those is a lie with a
    // timestamp.
    expect([...harness.cache.keys()]).not.toContain('/wallet')
    expect([...harness.cache.keys()]).not.toContain('/products/barbari')
    expect([...harness.cache.keys()]).not.toContain('/payments/result')
  })

  it('does not touch anything that is not a GET', async () => {
    const { request } = load()
    // A server action, a sign-in, a payment start. Nothing to have an opinion
    // about, and a worker that intercepts one is a worker that can lose one.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(await request('/checkout', { method, mode: 'navigate' })).toBeUndefined()
    }
  })

  it('leaves other origins alone', async () => {
    const { request } = load()
    // The payment gateway a customer is sent to, and the registrar's badge.
    expect(await request('https://gateway.example/pay/123')).toBeUndefined()
    expect(await request('https://trustseal.enamad.ir/logo.aspx')).toBeUndefined()
  })

  it('passes through the data requests a page makes for itself', async () => {
    const { request } = load()
    // Next fetches route data over GET on a client navigation. It is not a
    // navigation and not on the allow-list, so the worker stays out of it —
    // which is the whole reason the allow-list is a list of what to keep rather
    // than a list of what to skip.
    expect(await request('/orders?_rsc=1a2b3')).toBeUndefined()
    expect(await request('/_next/image?url=%2Fbread.png&w=640')).toBeUndefined()
  })

  it('does not confuse a bread’s page with a bread’s photograph', async () => {
    const { harness, request } = load()
    // `/products/` is two things at once: a folder of photographs in `public`,
    // and the route a bread's own page is served from. Matching on the folder
    // alone would cache the data request that page makes for itself — which
    // carries this morning's price, and would keep carrying it tomorrow.
    expect(await request('/products/barbari-konjedi?_rsc=9f8c2')).toBeUndefined()
    expect([...harness.cache.keys()]).toHaveLength(0)

    // The photograph, which does not change and is the reason the folder is on
    // the list at all, is still kept.
    await request('/products/barbari-konjedi.jpg')
    expect([...harness.cache.keys()]).toEqual(['/products/barbari-konjedi.jpg'])
  })
})

describe('what it does hold', () => {
  it('serves a fingerprinted asset from storage the second time', async () => {
    const { harness, request } = load()
    const asset = '/_next/static/chunks/main-9f8c2b1a.js'

    await request(asset)
    expect(harness.fetched).toContain(`${ORIGIN}${asset}`)
    expect([...harness.cache.keys()]).toContain(asset)

    harness.fetched.length = 0
    const second = await request(asset)
    // Not fetched again, and not revalidated behind the scenes: the URL changes
    // when the content does, so a hit is the answer rather than a guess.
    expect(harness.fetched).toHaveLength(0)
    expect(second).toBe(`cached:network:${ORIGIN}${asset}`)
  })

  it('keeps the fonts and the brand images, which are the slow ones', async () => {
    const { harness, request } = load()
    await request('/fonts/vazirmatn-400.woff2')
    await request('/brand/icon-192.png')
    expect([...harness.cache.keys()]).toEqual(
      expect.arrayContaining(['/fonts/vazirmatn-400.woff2', '/brand/icon-192.png']),
    )
  })

  it('refuses to keep a failure, or an answer it cannot read', async () => {
    // A 404 or a 500 kept in storage would pin the failure until the next
    // release — the shop would stay broken for the one customer whose phone
    // happened to ask at the wrong moment, and reloading would not fix it.
    const missing = load({ networkAnswers: { '/_next/static/chunks/gone.js': { ok: false } } })
    await missing.request('/_next/static/chunks/gone.js')
    expect([...missing.harness.cache.keys()]).toHaveLength(0)

    // An opaque response has an unknown status, so "did it work" is a question
    // that cannot be answered about it.
    const opaque = load({
      networkAnswers: { '/brand/icon-192.png': { ok: true, type: 'opaque' } },
    })
    await opaque.request('/brand/icon-192.png')
    expect([...opaque.harness.cache.keys()]).toHaveLength(0)
  })
})

describe('being offline', () => {
  it('answers a page with the shop’s own offline page', async () => {
    const { harness, dispatch, request } = load()
    // Installed first, because the offline page is only there if it was kept.
    await dispatch('install', {})
    expect([...harness.cache.keys()]).toContain('/offline')

    harness.offline = true
    const response = await request('/', { mode: 'navigate' })
    expect(response).toBe('precached:/offline')
  })

  it('still answers when even the offline page was never stored', async () => {
    const { harness, request } = load()
    harness.offline = true
    // A worker whose install was interrupted must not throw into a navigation;
    // the browser would show its own error and the customer would see nothing
    // of the shop at all.
    const response = await request('/', { mode: 'navigate' })
    expect(response).toBeDefined()
  })
})

describe('upgrading', () => {
  it('drops its own old versions and nothing else', async () => {
    const { harness, dispatch } = load({
      cacheNames: ['alo-noon-v0', 'alo-noon-v1', 'workbox-precache', 'some-other-app-v3'],
    })
    await dispatch('activate', {})

    expect(harness.deletedCaches).toEqual(['alo-noon-v0'])
    // Somebody else's storage on a shared origin is not ours to clear.
    expect(harness.deletedCaches).not.toContain('some-other-app-v3')
    expect(harness.claimCalled).toBe(true)
  })

  it('takes over at once, which is only safe because it caches no pages', async () => {
    const { harness, dispatch } = load()
    await dispatch('install', {})
    expect(harness.skipWaitingCalled).toBe(true)
  })

  it('installs even when part of the precache cannot be fetched', async () => {
    const { harness, dispatch } = load()
    harness.offline = true
    // One missing icon must not cost the installation, or the worker ends up
    // with no offline page either.
    await expect(dispatch('install', {})).resolves.toBeUndefined()
    expect(harness.skipWaitingCalled).toBe(true)
  })
})
