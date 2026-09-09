/**
 * The catalogue of staff permissions and the roles that bundle them.
 *
 * Two things depend on this being one list rather than several: the provisioning
 * CLI, which creates the rows, and the admin routes, which check them. When they
 * drifted apart the failure was silent — a role could be granted that no route
 * would ever accept, and the operator would see a permission denial with nothing
 * to act on.
 *
 * A permission means the same thing wherever it is held; what changes is how far
 * it reaches. The platform's own staff hold their roles at GLOBAL scope and see
 * the tenant. A bakery partner's staff hold theirs against one branch and see
 * that branch — the same `admin.orders.manage`, confined by the grant rather
 * than by a second permission that would have to be kept in step with the first.
 * `AdminRoleDefinition.scope` says which a role is for, and
 * `grantScopeMatchesRole` refuses the mismatch.
 *
 * City, operational-zone and courier-partner scopes are modelled in the database
 * and honoured by `authorizeGrants`, but no surface issues them yet.
 */
export const ADMIN_PERMISSIONS = {
  paymentProviderGovern: 'payment-provider.configuration.govern',
  authDeliveryProviderGovern: 'auth-delivery-provider.configuration.govern',
  notificationProviderGovern: 'notification-provider.configuration.govern',
  routingProviderGovern: 'routing-provider.configuration.govern',
  reportsRead: 'admin.reports.read',
  ordersRead: 'admin.orders.read',
  ordersManage: 'admin.orders.manage',
  catalogManage: 'admin.catalog.manage',
  accessManage: 'admin.access.manage',
  financeSettle: 'admin.finance.settle',
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
  {
    code: ADMIN_PERMISSIONS.routingProviderGovern,
    description: 'Configure routing engines and control their rotation',
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
  {
    code: ADMIN_PERMISSIONS.financeSettle,
    description: 'Prepare partner payouts and record that they were paid',
  },
])

/**
 * How far a role reaches.
 *
 * `TENANT` roles are granted once, at GLOBAL scope, and see everything the
 * tenant has. `BAKERY_BRANCH` roles are granted against one branch and see that
 * branch and nothing else — the bakery partner's own staff, who are not the
 * platform's staff and must never be handed a tenant-wide grant by accident.
 *
 * Stated on the role rather than left to whoever creates the grant, because the
 * dangerous mistake is silent in both directions: a branch role granted at
 * GLOBAL scope hands a shop counter every order in the city, and a tenant role
 * granted against a branch produces an operator who can sign in and do nothing,
 * with no error to act on.
 */
export type AdminRoleScope = 'TENANT' | 'BAKERY_BRANCH'

export interface AdminRoleDefinition {
  code: string
  /**
   * The English name, for a terminal and a log.
   *
   * The provisioning CLI prints it, and technical documentation uses it. It is
   * not what anybody reads on a screen.
   */
  name: string
  /**
   * The name on the screen where somebody decides who can move money.
   *
   * A role's *code* is the stable identifier and stays English forever, because
   * grants, tests and the CLI are all keyed on it. The name beside it is read
   * by a bakery owner in Sari deciding whether to hand a clerk the counter or
   * the bank account, and «Finance administrator» is not a sentence they should
   * have to parse to make that decision correctly.
   */
  nameFa: string
  scope: AdminRoleScope
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
    scope: 'TENANT',
    name: 'Provider governor',
    nameFa: 'مدیر سرویس‌دهنده‌ها',
    permissions: [
      ADMIN_PERMISSIONS.paymentProviderGovern,
      ADMIN_PERMISSIONS.authDeliveryProviderGovern,
      ADMIN_PERMISSIONS.notificationProviderGovern,
      ADMIN_PERMISSIONS.routingProviderGovern,
    ],
  },
  {
    code: 'OPERATIONS_ANALYST',
    scope: 'TENANT',
    name: 'Operations analyst',
    nameFa: 'کارشناس عملیات',
    permissions: [ADMIN_PERMISSIONS.reportsRead, ADMIN_PERMISSIONS.ordersRead],
  },
  {
    code: 'ORDER_OPERATOR',
    scope: 'TENANT',
    name: 'Order operator',
    nameFa: 'اپراتور سفارش',
    // The person in the shop: they see the queue and move it. Deliberately
    // without reports — accepting orders and reading revenue are different
    // jobs, and the first is the one a counter needs.
    permissions: [ADMIN_PERMISSIONS.ordersRead, ADMIN_PERMISSIONS.ordersManage],
  },
  {
    code: 'CATALOG_MANAGER',
    scope: 'TENANT',
    name: 'Catalog manager',
    nameFa: 'مدیر کاتالوگ',
    permissions: [ADMIN_PERMISSIONS.catalogManage, ADMIN_PERMISSIONS.reportsRead],
  },
  {
    code: 'ACCESS_ADMIN',
    scope: 'TENANT',
    name: 'Access administrator',
    nameFa: 'مدیر دسترسی‌ها',
    permissions: [ADMIN_PERMISSIONS.accessManage],
  },
  {
    // Paying partners is not reading a report about them. Separated for the same
    // reason ACCESS_ADMIN is: money leaving the platform's bank is the other
    // capability an operator can be trusted with everything else and still not
    // hold. Reports come with it because deciding a payout without seeing the
    // ledger it discharges is deciding blind.
    code: 'FINANCE_ADMIN',
    scope: 'TENANT',
    name: 'Finance administrator',
    nameFa: 'مدیر مالی',
    permissions: [ADMIN_PERMISSIONS.financeSettle, ADMIN_PERMISSIONS.reportsRead],
  },
  {
    code: 'TENANT_ADMIN',
    scope: 'TENANT',
    name: 'Tenant administrator',
    nameFa: 'مدیر مجموعه',
    permissions: [
      ADMIN_PERMISSIONS.paymentProviderGovern,
      ADMIN_PERMISSIONS.authDeliveryProviderGovern,
      ADMIN_PERMISSIONS.notificationProviderGovern,
      ADMIN_PERMISSIONS.routingProviderGovern,
      ADMIN_PERMISSIONS.reportsRead,
      ADMIN_PERMISSIONS.ordersRead,
      ADMIN_PERMISSIONS.ordersManage,
      ADMIN_PERMISSIONS.catalogManage,
      ADMIN_PERMISSIONS.accessManage,
      ADMIN_PERMISSIONS.financeSettle,
    ],
  },
  /**
   * The bakery's own people, at one branch.
   *
   * They are not the platform's staff and the difference is not a formality:
   * a partner's counter clerk holding a tenant-wide grant would see every
   * competitor's orders in the city. Both roles below are granted against a
   * branch, and every surface that honours them confines itself to it.
   */
  {
    code: 'BRANCH_OPERATOR',
    scope: 'BAKERY_BRANCH',
    name: 'Branch operator',
    nameFa: 'اپراتور شعبه',
    // The counter: see the queue, accept it, bake it, hand it over. No reports,
    // for the same reason ORDER_OPERATOR has none — taking orders and reading
    // revenue are different jobs.
    permissions: [ADMIN_PERMISSIONS.ordersRead, ADMIN_PERMISSIONS.ordersManage],
  },
  {
    code: 'BRANCH_OWNER',
    scope: 'BAKERY_BRANCH',
    name: 'Branch owner',
    nameFa: 'صاحب شعبه',
    // The person whose money it is: everything the counter can do, plus what
    // the branch has earned and what has been paid out against it. Never
    // financeSettle — reading what one is owed and deciding to pay it are
    // opposite ends of the same transaction, and a partner does not hold both.
    permissions: [
      ADMIN_PERMISSIONS.ordersRead,
      ADMIN_PERMISSIONS.ordersManage,
      ADMIN_PERMISSIONS.reportsRead,
    ],
  },
])

export function findAdminRole(code: string): AdminRoleDefinition | undefined {
  return ADMIN_ROLES.find((role) => role.code === code)
}

export function adminRoleCodes(): readonly string[] {
  return ADMIN_ROLES.map((role) => role.code)
}

/** The roles a bakery partner's own staff hold, each against one branch. */
export function branchRoleCodes(): readonly string[] {
  return ADMIN_ROLES.filter((role) => role.scope === 'BAKERY_BRANCH').map((role) => role.code)
}

/**
 * Whether a role may be granted at the scope somebody chose for it.
 *
 * A branch role at GLOBAL scope hands a shop counter the whole city; a tenant
 * role against a branch produces an operator who signs in successfully and can
 * do nothing, with no error anywhere that says why. Both are refused here, at
 * the one place a grant is created.
 */
export function grantScopeMatchesRole(
  role: AdminRoleDefinition,
  scopeType: string,
  scopeId: string | null,
): boolean {
  return role.scope === 'BAKERY_BRANCH'
    ? scopeType === 'BAKERY_BRANCH' && typeof scopeId === 'string' && scopeId.length > 0
    : scopeType === 'GLOBAL' && scopeId === null
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
