import { describe, expect, it } from 'vitest'

import { tenantHostAliases } from './modules/auth'

/**
 * Which hostnames a deployment has to answer to.
 *
 * This exists because of a launch-day failure that leaves no trace: a tenant is
 * found by its host, a host with no row finds no tenant, and the API then
 * answers "the requested service is unavailable" — which from outside looks
 * exactly like DNS being broken or the server being down. Nothing in a log says
 * "somebody typed www".
 *
 * The launch domain is the live example. `alonoon.ir`, `www.alonoon.ir` and
 * `staging.alonoon.ir` all resolve to one address in DNS; the tenant had rows
 * for neither of the first two.
 */
describe('the hostnames one deployment answers to', () => {
  it('pairs an apex with its www sibling, because they are one site', () => {
    expect(tenantHostAliases('alonoon.ir')).toEqual(['alonoon.ir', 'www.alonoon.ir'])
  })

  it('pairs a www host back to its apex, whichever way the operator typed it', () => {
    expect(tenantHostAliases('www.alonoon.ir')).toEqual(['alonoon.ir', 'www.alonoon.ir'])
  })

  it('invents no sibling for a subdomain that already names itself', () => {
    // `www.staging.alonoon.ir` is nobody's address, and a row for it is a row
    // nothing can ever reach.
    expect(tenantHostAliases('staging.alonoon.ir')).toEqual(['staging.alonoon.ir'])
    expect(tenantHostAliases('api.alonoon.ir')).toEqual(['api.alonoon.ir'])
  })

  it('leaves a local host alone', () => {
    expect(tenantHostAliases('localhost:3001')).toEqual(['localhost:3001'])
    expect(tenantHostAliases('127.0.0.1')).toEqual(['127.0.0.1'])
  })

  it('normalises the way host resolution does, so the rows match the lookups', () => {
    // A trailing dot is a legal absolute name and arrives from some clients.
    expect(tenantHostAliases('ALONOON.IR.')).toEqual(['alonoon.ir', 'www.alonoon.ir'])
  })

  it('treats a bare "www." as the typo it is rather than as a pair', () => {
    // The trailing dot is stripped first, exactly as host resolution strips it,
    // so this is the single label «www» and there is no apex to pair it with.
    expect(tenantHostAliases('www.')).toEqual(['www'])
  })

  it('answers with nothing for nothing', () => {
    expect(tenantHostAliases('   ')).toEqual([])
  })
})
