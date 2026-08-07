import { describe, expect, it } from 'vitest'

import {
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_DEFINITIONS,
  ADMIN_ROLES,
  adminRoleCodes,
  findAdminRole,
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
