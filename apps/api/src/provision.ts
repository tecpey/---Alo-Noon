/**
 * Operator provisioning CLI.
 *
 * Configuring a payment gateway or SMS provider has no admin UI and no HTTP
 * route yet, so this is the supported way to do it before soft launch. Every
 * command is idempotent: re-running it either returns what already exists or
 * fails loudly on a conflict, so it is safe to run again after a partial setup.
 *
 * Run with:  pnpm --filter @alo-noon/api provision <command> [--flag value]
 * See docs/operations/ADMIN_OPERATIONS_GUIDE_FA.md for the full Persian guide.
 */
import { randomBytes, randomUUID } from 'node:crypto'

import { PrismaClient } from '@alo-noon/database'
import {
  ADMIN_PERMISSION_DEFINITIONS,
  ADMIN_ROLES,
  adminRoleCodes,
  createPaymentProviderAdapterRegistry,
  findAdminRole,
  type AdminRoleDefinition,
} from '@alo-noon/domain'

import { createIdPayAdapter } from './providers/idpay.js'
import { createNextPayAdapter } from './providers/nextpay.js'
import { createShepaAdapter } from './providers/shepa.js'
import {
  createPrismaAuthDeliveryProviderService,
  AuthDeliveryProviderError,
} from './modules/auth-delivery-provider.js'
import {
  createPrismaPaymentProviderService,
  PaymentProviderError,
} from './modules/payment-provider.js'
import { encryptPaymentSecret, parseEncryptionKey } from './providers/secret-resolver.js'

type Flags = Readonly<Record<string, string | undefined>>

function parseFlags(argv: readonly string[]): Flags {
  const flags: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true'
      continue
    }
    flags[key] = next
    index += 1
  }
  return flags
}

function required(flags: Flags, name: string): string {
  const value = flags[name]
  if (!value) throw new Error(`Missing required flag --${name}`)
  return value
}

function asBoolean(flags: Flags, name: string, fallback: boolean): boolean {
  const value = flags[name]
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Flag --${name} must be true or false`)
}

const COMMANDS = [
  'generate-encryption-key',
  'encrypt-payment-secret',
  'list-roles',
  'grant-role',
  'revoke-role',
  'list-staff',
  'configure-payment-gateway',
  'set-payment-gateway-health',
  'configure-sms-provider',
  'list-sms-providers',
  'set-sms-provider-health',
] as const

/**
 * Bootstrap only. A role grant is what lets a staff account reach the admin
 * routes at all, so the very first one cannot itself be issued through those
 * routes. Everything after that is done from the admin panel.
 *
 * Roles and permissions come from the domain catalogue rather than being spelled
 * out here, so a role this CLI creates is always one the routes actually check.
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    process.stdout.write(
      `Usage: provision <command> [flags]\n\nCommands:\n  ${COMMANDS.join('\n  ')}\n`,
    )
    process.exitCode = command ? 1 : 0
    return
  }

  // These two never touch the database, so they work before any deployment.
  if (command === 'generate-encryption-key') {
    process.stdout.write(`${randomBytes(32).toString('base64')}\n`)
    return
  }
  if (command === 'encrypt-payment-secret') {
    const key = parseEncryptionKey(
      flags['encryption-key'] ?? process.env['PAYMENT_SECRET_ENCRYPTION_KEY'],
    )
    process.stdout.write(`${encryptPaymentSecret(required(flags, 'secret'), key)}\n`)
    return
  }

  // Listing the catalogue reads nothing, so it works before any deployment and
  // before a tenant exists.
  if (command === 'list-roles') {
    for (const role of ADMIN_ROLES) {
      process.stdout.write(`${role.code}  ${role.name}\n`)
      for (const permission of role.permissions) process.stdout.write(`    ${permission}\n`)
    }
    return
  }

  const prisma = new PrismaClient()
  const now = new Date()
  const correlationId = randomUUID()
  const tenantId = required(flags, 'tenant')

  try {
    if (command === 'list-staff') {
      const grants = await prisma.accessGrant.findMany({
        where: {
          revokedAt: null,
          scopeType: 'GLOBAL',
          role: { code: { in: [...adminRoleCodes()] } },
          account: { tenantMemberships: { some: { tenantId, status: 'ACTIVE', revokedAt: null } } },
        },
        include: { account: true, role: true },
        orderBy: { createdAt: 'asc' },
      })
      if (grants.length === 0) {
        process.stdout.write('No staff account holds an admin role in this tenant.\n')
        return
      }
      for (const grant of grants) {
        const expiry = grant.expiresAt ? ` expires=${grant.expiresAt.toISOString()}` : ''
        process.stdout.write(`${grant.account.mobileE164}  ${grant.role.code}${expiry}\n`)
      }
      return
    }

    if (command === 'grant-role' || command === 'revoke-role') {
      const mobileE164 = required(flags, 'mobile')
      const roleCode = required(flags, 'role').toUpperCase()
      const definition = findAdminRole(roleCode)
      if (!definition) {
        throw new Error(`Unknown role ${roleCode}. Known roles: ${adminRoleCodes().join(', ')}`)
      }
      const reason = required(flags, 'reason')

      // The account is created by the operator signing in with OTP first, which
      // is also what proves they control the number.
      const account = await prisma.identityAccount.findUnique({ where: { mobileE164 } })
      if (!account) {
        throw new Error(`No identity account for ${mobileE164}; sign in once with OTP first`)
      }
      const membership = await prisma.tenantMembership.findFirst({
        where: { tenantId, accountId: account.id, status: 'ACTIVE', revokedAt: null },
      })
      if (!membership) {
        throw new Error(`${mobileE164} is not an active member of tenant ${tenantId}`)
      }

      const role = await ensureRole(prisma, definition)
      // Admin capabilities are tenant-wide, so the grant is GLOBAL. The services
      // accept nothing narrower.
      const existing = await prisma.accessGrant.findFirst({
        where: {
          accountId: account.id,
          roleId: role.id,
          scopeType: 'GLOBAL',
          scopeId: null,
          revokedAt: null,
        },
      })

      if (command === 'revoke-role') {
        if (!existing) {
          process.stdout.write(`${mobileE164} does not hold ${roleCode}\n`)
          return
        }
        await prisma.accessGrant.update({ where: { id: existing.id }, data: { revokedAt: now } })
        await writeGrantAudit(prisma, {
          tenantId,
          entityId: existing.id,
          action: 'authorization.role.revoked',
          summary: `Role ${roleCode} revoked from ${mobileE164}`,
          reason,
          correlationId,
          now,
        })
        process.stdout.write(`Role ${roleCode} revoked from ${mobileE164}\n`)
        return
      }

      if (existing) {
        process.stdout.write(`${mobileE164} already holds ${roleCode}\n`)
        return
      }
      const grant = await prisma.accessGrant.create({
        data: { accountId: account.id, roleId: role.id, scopeType: 'GLOBAL', activeAt: now },
      })
      await writeGrantAudit(prisma, {
        tenantId,
        entityId: grant.id,
        action: 'authorization.role.granted',
        summary: `Role ${roleCode} granted to ${mobileE164}`,
        reason,
        correlationId,
        now,
      })
      process.stdout.write(
        `Role ${roleCode} granted to ${mobileE164}\n` +
          `Permissions: ${definition.permissions.join(', ')}\n`,
      )
      return
    }

    if (command === 'set-payment-gateway-health') {
      const providerService = createPrismaPaymentProviderService(prisma, {
        allowSystemOperations: true,
      })
      const configuration = await providerService.setConfigurationHealth(
        tenantId,
        {
          actor: 'SYSTEM',
          providerConfigurationId: required(flags, 'configuration'),
          healthStatus: required(flags, 'health').toUpperCase() as
            'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY',
          reason: required(flags, 'reason'),
        },
        now,
        correlationId,
      )
      process.stdout.write(
        `Payment gateway ${configuration.providerCode} health is now ${required(flags, 'health').toUpperCase()}\n`,
      )
      return
    }

    if (command === 'configure-payment-gateway') {
      // Governance verifies the configuration against a real adapter, so the
      // registry must be present or a gateway could be activated with no code
      // able to serve it. The callback URL is not exercised during provisioning.
      const callbackBase = process.env['PAYMENT_CALLBACK_BASE_URL'] ?? 'https://callback.invalid'
      const callbackUrlFor = (code: string) =>
        new URL(`/api/v1/payments/callback/${code.toLowerCase()}`, callbackBase).toString()
      const providerService = createPrismaPaymentProviderService(prisma, {
        allowSystemOperations: true,
        adapterRegistry: createPaymentProviderAdapterRegistry([
          createNextPayAdapter({ callbackUrl: callbackUrlFor('NEXTPAY') }),
          createShepaAdapter({ callbackUrl: callbackUrlFor('SHEPA') }),
          createIdPayAdapter({ callbackUrl: callbackUrlFor('IDPAY') }),
        ]),
      })
      const providerCode = required(flags, 'provider').toUpperCase()
      const reference = required(flags, 'credential-reference')
      const idempotencyKey = flags['idempotency-key'] ?? `provision-${providerCode}-credential`

      const credential = await providerService.createCredentialReference(
        tenantId,
        {
          actor: 'SYSTEM',
          providerCode,
          reference,
          keyVersion: flags['key-version'] ?? 'v1',
          metadata: {},
          idempotencyKey,
        },
        now,
        correlationId,
      )

      const configuration = await providerService.createConfiguration(
        tenantId,
        {
          actor: 'SYSTEM',
          providerCode,
          adapterVersion: flags['adapter-version'] ?? '1.0.0',
          adapterSpiVersion: 1,
          merchantReference: required(flags, 'merchant-reference'),
          environment: (flags['environment'] ?? 'TEST') as 'TEST' | 'PRODUCTION',
          paymentContext: 'CHECKOUT',
          currency: 'IRR',
          callbackPolicy: 'SIGNED_ONLY',
          capabilities: ['PAYMENT_INITIALIZATION'],
          credentialReferenceId: credential.id,
          idempotencyKey: `${idempotencyKey}-configuration`,
          reason: flags['reason'] ?? 'Operator provisioning',
        },
        now,
        correlationId,
      )

      // A configuration only becomes selectable once it is active and default.
      await providerService.governConfiguration(
        tenantId,
        {
          actor: 'SYSTEM',
          providerConfigurationId: configuration.id,
          targetActive: asBoolean(flags, 'active', true),
          makeDefault: asBoolean(flags, 'default', true),
          idempotencyKey: `${idempotencyKey}-governance`,
          reason: flags['reason'] ?? 'Operator provisioning',
        },
        now,
        correlationId,
      )

      process.stdout.write(
        `Payment gateway configured\n  configurationId: ${configuration.id}\n  provider: ${providerCode}\n`,
      )
      process.stdout.write(
        'Health starts UNKNOWN and must be HEALTHY before the gateway is selectable.\n',
      )
      return
    }

    const smsService = createPrismaAuthDeliveryProviderService(prisma, {
      allowSystemOperations: true,
    })

    if (command === 'configure-sms-provider') {
      const configuration = await smsService.createConfiguration(
        tenantId,
        {
          actor: 'SYSTEM',
          providerCode: required(flags, 'provider').toUpperCase(),
          adapterVersion: flags['adapter-version'] ?? '1.0.0',
          environment: (flags['environment'] ?? 'TEST') as 'TEST' | 'PRODUCTION',
          credentialReference: required(flags, 'credential-reference'),
          senderReference: required(flags, 'sender'),
          templateReference: required(flags, 'template'),
          enabled: asBoolean(flags, 'enabled', true),
          isDefault: asBoolean(flags, 'default', true),
          ...(flags['priority'] && { priority: Number(flags['priority']) }),
          reason: flags['reason'] ?? 'Operator provisioning',
        },
        now,
        correlationId,
      )
      process.stdout.write(
        `SMS provider configured\n  configurationId: ${configuration.id}\n  provider: ${configuration.providerCode}\n`,
      )
      process.stdout.write(
        'This configuration is immutable. Use set-sms-provider-health to take it out of rotation.\n',
      )
      return
    }

    if (command === 'list-sms-providers') {
      const configurations = await smsService.listConfigurations(tenantId, { actor: 'SYSTEM' }, now)
      if (configurations.length === 0) {
        process.stdout.write('No SMS provider is configured for this tenant.\n')
        return
      }
      for (const configuration of configurations) {
        process.stdout.write(
          `${configuration.id}  ${configuration.providerCode}  ${configuration.environment}  ` +
            `enabled=${configuration.enabled}  default=${configuration.isDefault}  ` +
            `health=${configuration.healthStatus}\n`,
        )
      }
      return
    }

    if (command === 'set-sms-provider-health') {
      const configuration = await smsService.setConfigurationHealth(
        tenantId,
        {
          actor: 'SYSTEM',
          configurationId: required(flags, 'configuration'),
          healthStatus: required(flags, 'health').toUpperCase() as
            'HEALTHY' | 'DEGRADED' | 'UNHEALTHY',
          reason: required(flags, 'reason'),
        },
        now,
        correlationId,
      )
      process.stdout.write(
        `SMS provider health is now ${configuration.healthStatus} for ${configuration.providerCode}\n`,
      )
      return
    }
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Creates the role and its permission rows if they are missing, and reconciles
 * the role's permissions with the catalogue. Reconciling matters on upgrade: a
 * role granted last month must gain a permission added since, or an operator
 * would hold a role whose name no longer matches what it opens.
 */
async function ensureRole(
  prisma: PrismaClient,
  definition: AdminRoleDefinition,
): Promise<{ id: string }> {
  const role = await prisma.authorizationRole.upsert({
    where: { code: definition.code },
    update: { name: definition.name },
    create: { code: definition.code, name: definition.name },
  })
  for (const code of definition.permissions) {
    const description =
      ADMIN_PERMISSION_DEFINITIONS.find((entry) => entry.code === code)?.description ?? code
    const permission = await prisma.authorizationPermission.upsert({
      where: { code },
      update: {},
      create: { code, description },
    })
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    })
  }
  // Permissions dropped from a role in the catalogue are removed here too, so a
  // narrowed role actually narrows rather than keeping its old reach.
  const keep = new Set<string>(definition.permissions)
  const attached = await prisma.rolePermission.findMany({
    where: { roleId: role.id },
    include: { permission: true },
  })
  const stale = attached.filter((entry) => !keep.has(entry.permission.code))
  if (stale.length > 0) {
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { in: stale.map((entry) => entry.permissionId) } },
    })
  }
  return role
}

async function writeGrantAudit(
  prisma: PrismaClient,
  input: {
    tenantId: string
    entityId: string
    action: string
    summary: string
    reason: string
    correlationId: string
    now: Date
  },
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      action: input.action,
      entityType: 'access_grant',
      entityId: input.entityId,
      summary: input.summary,
      correlationId: input.correlationId,
      metadata: { reason: input.reason },
      occurredAt: input.now,
    },
  })
}

main().catch((error: unknown) => {
  const code =
    error instanceof AuthDeliveryProviderError || error instanceof PaymentProviderError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'UNKNOWN_ERROR'
  process.stderr.write(`Provisioning failed: ${code}\n`)
  process.exitCode = 1
})
