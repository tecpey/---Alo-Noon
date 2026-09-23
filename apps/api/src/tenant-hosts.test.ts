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
 * The launch domain is the live example. `alonon.ir`, `www.alonon.ir` and
 * `staging.alonon.ir` all resolve to one address in DNS; the tenant had rows
 * for neither of the first two.
 */
describe('the hostnames one deployment answers to', () => {
  it('pairs an apex with its www sibling, because they are one site', () => {
    expect(tenantHostAliases('alonon.ir')).toEqual(['alonon.ir', 'www.alonon.ir'])
  })

  it('pairs a www host back to its apex, whichever way the operator typed it', () => {
    expect(tenantHostAliases('www.alonon.ir')).toEqual(['alonon.ir', 'www.alonon.ir'])
  })

  it('invents no sibling for a subdomain that already names itself', () => {
    // `www.staging.alonon.ir` is nobody's address, and a row for it is a row
    // nothing can ever reach.
    expect(tenantHostAliases('staging.alonon.ir')).toEqual(['staging.alonon.ir'])
    expect(tenantHostAliases('api.alonon.ir')).toEqual(['api.alonon.ir'])
  })

  it('leaves a local host alone', () => {
    expect(tenantHostAliases('localhost:3001')).toEqual(['localhost:3001'])
    expect(tenantHostAliases('127.0.0.1')).toEqual(['127.0.0.1'])
  })

  it('normalises the way host resolution does, so the rows match the lookups', () => {
    // A trailing dot is a legal absolute name and arrives from some clients.
    expect(tenantHostAliases('ALONON.IR.')).toEqual(['alonon.ir', 'www.alonon.ir'])
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
