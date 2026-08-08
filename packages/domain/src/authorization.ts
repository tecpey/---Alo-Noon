/**
 * The catalogue of staff permissions and the roles that bundle them.
 *
 * Two things depend on this being one list rather than several: the provisioning
 * CLI, which creates the rows, and the admin routes, which check them. When they
 * drifted apart the failure was silent — a role could be granted that no route
 * would ever accept, and the operator would see a permission denial with nothing
 * to act on.
 *
 * Every permission here is checked at GLOBAL scope. Narrower scopes (city,
 * branch, courier partner) are modelled in the database and honoured by
 * `authorizeGrants`, but no admin surface uses them yet: a half-scoped operator
 * seeing tenant-wide totals would be worse than no report at all.
 */
export const ADMIN_PERMISSIONS = {
  paymentProviderGovern: 'payment-provider.configuration.govern',
  authDeliveryProviderGovern: 'auth-delivery-provider.configuration.govern',
  notificationProviderGovern: 'notification-provider.configuration.govern',
  reportsRead: 'admin.reports.read',
  ordersRead: 'admin.orders.read',
  ordersManage: 'admin.orders.manage',
  catalogManage: 'admin.catalog.manage',
  accessManage: 'admin.access.manage',
} as const

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS]

export interface AdminPermissionDefinition {
  code: AdminPermission
  /** Recorded on the permission row; explains the grant to whoever audits it. */
  description: string
}

export const ADMIN_PERMISSION_DEFINITIONS: readonly AdminPermissionDefinition[] = Object.freeze([
  {
    code: ADMIN_PERMISSIONS.paymentProviderGovern,
    description: 'Configure, activate, and attest payment gateway configurations',
  },
  {
    code: ADMIN_PERMISSIONS.authDeliveryProviderGovern,
    description: 'Configure authentication SMS providers and control their rotation',
  },
  {
    code: ADMIN_PERMISSIONS.notificationProviderGovern,
    description: 'Configure notification providers and control their rotation',
  },
  { code: ADMIN_PERMISSIONS.reportsRead, description: 'Read tenant sales and operations reports' },
  { code: ADMIN_PERMISSIONS.ordersRead, description: 'Read any order in the tenant' },
  {
    code: ADMIN_PERMISSIONS.ordersManage,
    description: 'Accept, reject, and advance orders through fulfillment',
  },
  { code: ADMIN_PERMISSIONS.catalogManage, description: 'Manage catalog, offerings, and pricing' },
  {
    code: ADMIN_PERMISSIONS.accessManage,
    description: 'Grant and revoke staff roles within the tenant',
  },
])

export interface AdminRoleDefinition {
  code: string
  name: string
  permissions: readonly AdminPermission[]
}

/**
 * Roles are deliberately coarse. A tenant running a pilot has a handful of
 * operators, and a fine-grained matrix nobody maintains ends up granting
 * TENANT_ADMIN to everyone — which is worse than admitting the roles are broad.
 *
 * ACCESS_ADMIN is separated from TENANT_ADMIN on purpose: the ability to widen
 * someone's access, including one's own, is the one capability that should be
 * possible to withhold from an otherwise fully privileged operator.
 */
export const ADMIN_ROLES: readonly AdminRoleDefinition[] = Object.freeze([
  {
    code: 'PROVIDER_GOVERNOR',
    name: 'Provider governor',
    permissions: [
      ADMIN_PERMISSIONS.paymentProviderGovern,
      ADMIN_PERMISSIONS.authDeliveryProviderGovern,
      ADMIN_PERMISSIONS.notificationProviderGovern,
    ],
  },
  {
    code: 'OPERATIONS_ANALYST',
    name: 'Operations analyst',
    permissions: [ADMIN_PERMISSIONS.reportsRead, ADMIN_PERMISSIONS.ordersRead],
  },
  {
    code: 'ORDER_OPERATOR',
    name: 'Order operator',
    // The person in the shop: they see the queue and move it. Deliberately
    // without reports — accepting orders and reading revenue are different
    // jobs, and the first is the one a counter needs.
    permissions: [ADMIN_PERMISSIONS.ordersRead, ADMIN_PERMISSIONS.ordersManage],
  },
  {
    code: 'CATALOG_MANAGER',
    name: 'Catalog manager',
    permissions: [ADMIN_PERMISSIONS.catalogManage, ADMIN_PERMISSIONS.reportsRead],
  },
  {
    code: 'ACCESS_ADMIN',
    name: 'Access administrator',
    permissions: [ADMIN_PERMISSIONS.accessManage],
  },
  {
    code: 'TENANT_ADMIN',
    name: 'Tenant administrator',
    permissions: [
      ADMIN_PERMISSIONS.paymentProviderGovern,
      ADMIN_PERMISSIONS.authDeliveryProviderGovern,
      ADMIN_PERMISSIONS.notificationProviderGovern,
      ADMIN_PERMISSIONS.reportsRead,
      ADMIN_PERMISSIONS.ordersRead,
      ADMIN_PERMISSIONS.ordersManage,
      ADMIN_PERMISSIONS.catalogManage,
      ADMIN_PERMISSIONS.accessManage,
    ],
  },
])

export function findAdminRole(code: string): AdminRoleDefinition | undefined {
  return ADMIN_ROLES.find((role) => role.code === code)
}

export function adminRoleCodes(): readonly string[] {
  return ADMIN_ROLES.map((role) => role.code)
}

/**
 * Permissions a role grants that the caller does not already hold.
 *
 * Granting a role is itself a privileged act, and the guard that matters is not
 * "may this account grant roles" but "may it grant *this* role". Without this,
 * an ACCESS_ADMIN — whose only permission is to manage access — could hand
 * itself TENANT_ADMIN and own the tenant. Callers use it to refuse a grant that
 * would widen anyone's reach beyond the granter's own.
 */
export function permissionsBeyond(
  role: AdminRoleDefinition,
  heldPermissions: readonly string[],
): readonly AdminPermission[] {
  const held = new Set(heldPermissions)
  return role.permissions.filter((permission) => !held.has(permission))
}
