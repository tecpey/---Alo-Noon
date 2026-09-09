import { describe, expect, it } from 'vitest'

import {
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_DEFINITIONS,
  ADMIN_ROLES,
  adminRoleCodes,
  branchRoleCodes,
  findAdminRole,
  grantScopeMatchesRole,
  permissionsBeyond,
} from './authorization'

describe('admin permission catalogue', () => {
  it('defines every permission it names', () => {
    const defined = new Set(ADMIN_PERMISSION_DEFINITIONS.map((entry) => entry.code))
    for (const permission of Object.values(ADMIN_PERMISSIONS)) {
      expect(defined.has(permission)).toBe(true)
    }
    expect(defined.size).toBe(Object.values(ADMIN_PERMISSIONS).length)
  })

  it('grants only permissions that exist', () => {
    // A role naming a permission no route checks is a grant that silently does
    // nothing, which is exactly the drift this catalogue exists to prevent.
    const defined = new Set(ADMIN_PERMISSION_DEFINITIONS.map((entry) => entry.code))
    for (const role of ADMIN_ROLES) {
      for (const permission of role.permissions) {
        expect(defined.has(permission)).toBe(true)
      }
    }
  })

  it('gives every permission at least one role that carries it', () => {
    const granted = new Set(ADMIN_ROLES.flatMap((role) => role.permissions))
    for (const permission of Object.values(ADMIN_PERMISSIONS)) {
      expect(granted.has(permission)).toBe(true)
    }
  })

  it('uses distinct role codes', () => {
    expect(new Set(adminRoleCodes()).size).toBe(ADMIN_ROLES.length)
  })

  it('resolves a role by code and nothing by an unknown one', () => {
    expect(findAdminRole('TENANT_ADMIN')?.permissions).toContain(ADMIN_PERMISSIONS.accessManage)
    expect(findAdminRole('NOT_A_ROLE')).toBeUndefined()
  })

  it('keeps access management separable from full administration', () => {
    // The point of ACCESS_ADMIN existing apart from TENANT_ADMIN is that an
    // operator can run everything without being able to widen anyone's reach.
    const accessAdmin = findAdminRole('ACCESS_ADMIN')
    expect(accessAdmin?.permissions).toEqual([ADMIN_PERMISSIONS.accessManage])
    expect(findAdminRole('PROVIDER_GOVERNOR')?.permissions).not.toContain(
      ADMIN_PERMISSIONS.accessManage,
    )
    expect(findAdminRole('OPERATIONS_ANALYST')?.permissions).not.toContain(
      ADMIN_PERMISSIONS.accessManage,
    )
  })

  it('keeps paying partners out of every role that only runs the shop', () => {
    // Money leaving the platform's bank is not something an order operator, a
    // catalogue manager or an analyst does, however much else they are trusted
    // with. Only FINANCE_ADMIN and TENANT_ADMIN carry it.
    const carriers = ADMIN_ROLES.filter((role) =>
      role.permissions.includes(ADMIN_PERMISSIONS.financeSettle),
    ).map((role) => role.code)
    expect(carriers).toEqual(['FINANCE_ADMIN', 'TENANT_ADMIN'])
    expect(findAdminRole('FINANCE_ADMIN')?.permissions).not.toContain(
      ADMIN_PERMISSIONS.ordersManage,
    )
  })
})

describe('how far a role reaches', () => {
  it('keeps the bakery partner roles branch-scoped and everything else tenant-wide', () => {
    expect(branchRoleCodes()).toEqual(['BRANCH_OPERATOR', 'BRANCH_OWNER'])
    for (const role of ADMIN_ROLES) {
      expect(role.scope).toBe(branchRoleCodes().includes(role.code) ? 'BAKERY_BRANCH' : 'TENANT')
    }
  })

  it('never lets a partner role carry a platform-wide capability', () => {
    // A bakery's own staff seeing the catalogue, the providers, the access
    // list or the payout desk would be the platform handing a partner the
    // platform. The queue and their own numbers is the whole of it.
    const forbidden = [
      ADMIN_PERMISSIONS.catalogManage,
      ADMIN_PERMISSIONS.accessManage,
      ADMIN_PERMISSIONS.financeSettle,
      ADMIN_PERMISSIONS.paymentProviderGovern,
    ]
    for (const code of branchRoleCodes()) {
      for (const permission of forbidden) {
        expect(findAdminRole(code)?.permissions).not.toContain(permission)
      }
    }
  })

  it('refuses a grant whose scope does not match the role', () => {
    const branch = findAdminRole('BRANCH_OPERATOR')!
    const tenant = findAdminRole('ORDER_OPERATOR')!

    expect(grantScopeMatchesRole(branch, 'BAKERY_BRANCH', 'branch-1')).toBe(true)
    expect(grantScopeMatchesRole(tenant, 'GLOBAL', null)).toBe(true)

    // The dangerous one: a counter clerk handed every order in the city.
    expect(grantScopeMatchesRole(branch, 'GLOBAL', null)).toBe(false)
    // And the silent one: an operator who signs in and can do nothing.
    expect(grantScopeMatchesRole(tenant, 'BAKERY_BRANCH', 'branch-1')).toBe(false)
    // A branch grant naming no branch is not a branch grant.
    expect(grantScopeMatchesRole(branch, 'BAKERY_BRANCH', null)).toBe(false)
    expect(grantScopeMatchesRole(branch, 'BAKERY_BRANCH', '')).toBe(false)
  })
})

describe('privilege escalation guard', () => {
  const tenantAdmin = findAdminRole('TENANT_ADMIN')!
  const analyst = findAdminRole('OPERATIONS_ANALYST')!

  it('reports what a role would add beyond what the granter holds', () => {
    expect(permissionsBeyond(analyst, [ADMIN_PERMISSIONS.reportsRead])).toEqual([
      ADMIN_PERMISSIONS.ordersRead,
    ])
  })

  it('is empty when the granter already holds everything the role carries', () => {
    expect(permissionsBeyond(analyst, tenantAdmin.permissions)).toEqual([])
  })

  it('stops an access administrator from granting itself the tenant', () => {
    // ACCESS_ADMIN's only permission is accessManage. Granting TENANT_ADMIN
    // would hand it six more, so the guard must report them.
    const accessAdmin = findAdminRole('ACCESS_ADMIN')!
    const escalation = permissionsBeyond(tenantAdmin, accessAdmin.permissions)
    expect(escalation.length).toBeGreaterThan(0)
    expect(escalation).toContain(ADMIN_PERMISSIONS.paymentProviderGovern)
  })

  it('ignores held permissions that are not part of the catalogue', () => {
    expect(permissionsBeyond(analyst, ['session.self.read'])).toEqual(analyst.permissions)
  })
})

/**
 * The names on the screen where somebody decides who can move money.
 *
 * A role's code is the identifier and stays English forever — grants, tests and
 * the provisioning CLI are all keyed on it. The name beside it is read by a
 * bakery owner in Sari deciding whether to hand a clerk the counter or the bank
 * account, and «Finance administrator» is not a sentence they should have to
 * parse to get that decision right.
 */
describe('roles, as an operator reads them', () => {
  it('gives every role a Persian name', () => {
    for (const role of ADMIN_ROLES) {
      // Persian script, not merely non-empty: a Latin string here would pass a
      // length check and still be the bug.
      expect(`${role.code}: ${role.nameFa}`).toMatch(/: [؀-ۿ]/)
    }
  })

  it('keeps the code an ASCII identifier, because everything is keyed on it', () => {
    for (const role of ADMIN_ROLES) {
      expect(role.code).toMatch(/^[A-Z][A-Z_]*$/)
    }
  })

  it('keeps the English name too, for a terminal and a log', () => {
    // The provisioning CLI prints it, and technical documentation uses it.
    // Dropping it would push Persian into places that are deliberately English.
    for (const role of ADMIN_ROLES) {
      expect(role.name).toMatch(/^[\x20-\x7E]+$/)
    }
  })

  it('names no two roles the same thing', () => {
    // Two roles reading identically in the grant dropdown is a way to hand out
    // the wrong one and never notice.
    const names = ADMIN_ROLES.map((role) => role.nameFa)
    expect(new Set(names).size).toBe(names.length)
  })

  it('says «شعبه» in the name of every role confined to one', () => {
    // Scope is a separate column, and a name that does not carry it is a name
    // that gets granted tenant-wide by somebody skimming.
    for (const role of ADMIN_ROLES) {
      if (role.scope !== 'BAKERY_BRANCH') continue
      expect(`${role.code}: ${role.nameFa}`).toContain('شعبه')
    }
  })
})
