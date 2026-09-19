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
  BABOL_PILOT_COVERAGE,
  circleToGeoJson,
  ADMIN_ROLES,
  branchRoleCodes,
  grantScopeMatchesRole,
  adminRoleCodes,
  createPaymentProviderAdapterRegistry,
  findAdminRole,
  type AdminRoleDefinition,
} from '@alo-noon/domain'

import { createIdPayAdapter } from './providers/idpay.js'
import { createNextPayAdapter } from './providers/nextpay.js'
import { createShepaAdapter } from './providers/shepa.js'
import { createZarinpalAdapter } from './providers/zarinpal.js'
import { createZibalAdapter } from './providers/zibal.js'
import {
  createPrismaAuthDeliveryProviderService,
  AuthDeliveryProviderError,
} from './modules/auth-delivery-provider.js'
import { createPrismaRoutingProviderService } from './modules/routing-provider.js'
import { geoJsonBoundariesOverlap } from './modules/discovery.js'
import {
  createPrismaAdminDeliveryPricingService,
  AdminDeliveryPricingError,
} from './modules/admin-delivery-pricing.js'
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
  'configure-routing-provider',
  'list-routing-providers',
  'set-routing-provider-health',
  'provision-coverage',
  'list-coverage',
  'publish-tariff',
  'list-tariffs',
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
      const scope = role.scope === 'BAKERY_BRANCH' ? '  (needs --branch)' : ''
      process.stdout.write(`${role.code}  ${role.name}${scope}\n`)
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
          // Branch grants are listed too: an operator auditing who can touch
          // what has to see the bakery counters, and a grant this command hides
          // is a grant that survives every review.
          scopeType: { in: ['GLOBAL', 'BAKERY_BRANCH'] },
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
        const scope = grant.scopeId ? ` branch=${grant.scopeId}` : ''
        process.stdout.write(`${grant.account.mobileE164}  ${grant.role.code}${scope}${expiry}\n`)
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

      // Where the grant reaches is decided by the role, not by the flag. A
      // branch role granted tenant-wide would hand a bakery's counter every
      // order in the city, so the branch is required rather than defaulted.
      const scopeType = definition.scope === 'BAKERY_BRANCH' ? 'BAKERY_BRANCH' : 'GLOBAL'
      const scopeId = definition.scope === 'BAKERY_BRANCH' ? (flags['branch'] ?? null) : null
      if (!grantScopeMatchesRole(definition, scopeType, scopeId)) {
        throw new Error(
          `${roleCode} is a branch role: pass --branch <bakeryBranchId>. Branch roles are ${branchRoleCodes().join(', ')}`,
        )
      }
      if (scopeId) {
        const branch = await prisma.bakeryBranch.findFirst({
          where: { id: scopeId, tenantId },
          select: { id: true, nameFa: true },
        })
        if (!branch) throw new Error(`No bakery branch ${scopeId} in tenant ${tenantId}`)
      }

      const role = await ensureRole(prisma, definition)
      const existing = await prisma.accessGrant.findFirst({
        where: { accountId: account.id, roleId: role.id, scopeType, scopeId, revokedAt: null },
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
        data: { accountId: account.id, roleId: role.id, scopeType, scopeId, activeAt: now },
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
          createZarinpalAdapter({ callbackUrl: callbackUrlFor('ZARINPAL') }),
          createZibalAdapter({ callbackUrl: callbackUrlFor('ZIBAL') }),
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
          // Both, always: a gateway that can start a payment but not verify it
          // takes money and never records it. The callback intake route refuses
          // a configuration without CALLBACK_VERIFICATION for the same reason.
          capabilities: ['PAYMENT_INITIALIZATION', 'CALLBACK_VERIFICATION'],
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
    const routingService = createPrismaRoutingProviderService(prisma, {
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

    // Goes through the same service the admin panel calls, so a configuration
    // made from a shell is validated and audited exactly like one made from the
    // panel. This used to be a raw Prisma write, which meant the setting that
    // decides every delivery distance could change with nothing recorded.
    if (command === 'configure-routing-provider') {
      const configuration = await routingService.createConfiguration(
        tenantId,
        {
          actor: 'SYSTEM',
          providerCode: required(flags, 'provider').toUpperCase(),
          adapterVersion: flags['adapter-version'] ?? '1.0.0',
          environment: (flags['environment'] ?? 'TEST') as 'TEST' | 'PRODUCTION',
          credentialReference: required(flags, 'credential-reference'),
          enabled: asBoolean(flags, 'enabled', true),
          isDefault: asBoolean(flags, 'default', true),
          ...(flags['priority'] && { priority: Number(flags['priority']) }),
          reason: flags['reason'] ?? 'Operator provisioning',
        },
        now,
        correlationId,
      )
      process.stdout.write(
        `Routing provider configured\n  configurationId: ${configuration.id}\n` +
          `  provider: ${configuration.providerCode}\n`,
      )
      process.stdout.write(
        'Health starts UNKNOWN. Until it is HEALTHY, delivery distance falls back ' +
          'to the scaled straight line — which is safe, but is not what you paid for.\n',
      )
      return
    }

    /**
     * Puts the coverage table in the domain package on the ground: a service
     * area per town, all inside one city and one operational zone.
     *
     * One zone for all of them, and that is forced rather than chosen: the
     * order path requires a cart's zone to equal its address's zone *and* its
     * branch's zone, so a Babol bakery can only reach an address whose service
     * area sits in the same zone the branch does. Separate zones per town would
     * make every Babolsar order a CART_CONTEXT_MISMATCH.
     *
     * ## Why the city and zone codes are flags
     *
     * They were literals — `BABOL_PILOT` and `BABOL_CATCHMENT` — which is
     * correct for a tenant that has never been set up and wrong for every
     * tenant that has. A shop already selling bread has a city and a zone
     * already, with its bakeries in them, under whatever codes its bootstrap
     * chose. Run against that shop, the literals created a *second* city and a
     * second zone, put eight perfectly good service areas inside them, and
     * changed nothing a customer could see: no branch sits in that zone, so no
     * order can reach any of it. A provisioning command whose successful output
     * describes a shop nobody can order from is worse than one that refuses.
     *
     * So the codes are flags, defaulting to the greenfield names. Point them at
     * the city and zone the bakeries are actually in, and the areas land where
     * orders can use them. The command upserts, so a wrong run is corrected by
     * a right one.
     *
     * ## Why it refuses to leave an overlap behind
     *
     * An address inside two active areas is refused as
     * `SERVICE_AREA_AMBIGUOUS`, which the customer reads as "they do not
     * deliver here". A zone that already has a broad placeholder area — a
     * rectangle drawn around the city to get the first order through — will
     * overlap half of this table the moment it is written, and the result is a
     * shop that silently stops serving its own centre.
     *
     * The command therefore checks every pre-existing active area in the zone
     * against the ones it is about to write, using the same containment test
     * the serviceability resolver uses, and stops before writing anything if
     * any of them collide. `--retire-unlisted true` is the operator saying "yes,
     * those were placeholders" — it deactivates them rather than deleting them,
     * because a service area is referenced by every address resolved inside it.
     * Areas that do not overlap are never touched: a tenant that has drawn a
     * real polygon for a village keeps it.
     */
    if (command === 'provision-coverage') {
      const cityCode = flags['city-code'] ?? 'BABOL_PILOT'
      const zoneCode = flags['zone-code'] ?? 'BABOL_CATCHMENT'
      const city = await prisma.city.upsert({
        where: { tenantId_code: { tenantId, code: cityCode } },
        update: { ...(flags['city-name'] && { nameFa: flags['city-name'] }), isActive: true },
        create: {
          tenantId,
          code: cityCode,
          nameFa: flags['city-name'] ?? 'بابل و حومه',
          timezone: 'Asia/Tehran',
          isActive: true,
        },
      })
      const zone = await prisma.operationalZone.upsert({
        where: { cityId_code: { cityId: city.id, code: zoneCode } },
        update: { ...(flags['zone-name'] && { nameFa: flags['zone-name'] }), isActive: true },
        create: {
          tenantId,
          cityId: city.id,
          code: zoneCode,
          nameFa: flags['zone-name'] ?? 'حوزهٔ بابل',
          isActive: true,
        },
      })

      const planned = BABOL_PILOT_COVERAGE.map((area) => ({
        area,
        boundaryGeoJson: circleToGeoJson(area, area.radiusMetres),
      }))
      const plannedCodes = new Set(planned.map((entry) => entry.area.code))
      const existing = await prisma.serviceArea.findMany({
        where: { tenantId, operationalZoneId: zone.id, isActive: true },
        select: { id: true, code: true, nameFa: true, boundaryGeoJson: true },
      })
      const colliding = existing
        .filter((area) => !plannedCodes.has(area.code))
        .map((area) => ({
          area,
          overlaps: planned
            .filter((entry) =>
              geoJsonBoundariesOverlap(area.boundaryGeoJson, entry.boundaryGeoJson),
            )
            .map((entry) => entry.area.nameFa),
        }))
        .filter((entry) => entry.overlaps.length > 0)

      const retireUnlisted = asBoolean(flags, 'retire-unlisted', false)
      if (colliding.length > 0 && !retireUnlisted) {
        // Nothing has been written to `ServiceArea` yet, so refusing here leaves
        // the zone exactly as it was rather than half-provisioned.
        process.stdout.write(
          'Refusing to provision: these active areas overlap the coverage table.\n' +
            'Every address inside an overlap would be refused as SERVICE_AREA_AMBIGUOUS,\n' +
            'which a customer reads as "out of range".\n\n',
        )
        for (const entry of colliding) {
          process.stdout.write(
            `  ${entry.area.code.padEnd(20)} ${entry.area.nameFa}\n` +
              `      overlaps: ${entry.overlaps.join('، ')}\n`,
          )
        }
        process.stdout.write(
          '\nRe-run with --retire-unlisted true to deactivate them, or rename them to\n' +
            'match the coverage table if they are the same places under other codes.\n',
        )
        process.exitCode = 1
        return
      }

      process.stdout.write(
        `City   ${city.nameFa}  (${city.code})\nZone   ${zone.nameFa}  (${zone.code})\n\n`,
      )
      for (const { area, boundaryGeoJson } of planned) {
        const saved = await prisma.serviceArea.upsert({
          where: { operationalZoneId_code: { operationalZoneId: zone.id, code: area.code } },
          update: {
            nameFa: area.nameFa,
            boundaryGeoJson,
            motorcycleAllowed: area.motorcycleAllowed,
            isActive: true,
          },
          create: {
            tenantId,
            operationalZoneId: zone.id,
            code: area.code,
            nameFa: area.nameFa,
            boundaryGeoJson,
            motorcycleAllowed: area.motorcycleAllowed,
            isActive: true,
          },
        })
        const vehicle = area.motorcycleAllowed ? 'موتور و خودرو' : 'فقط خودرو'
        process.stdout.write(
          `  ${area.nameFa.padEnd(20)} ${String(area.radiusMetres / 1000).padStart(4)}km  ${vehicle}  ${saved.id}\n`,
        )
      }

      for (const entry of colliding) {
        // Deactivated, never deleted: an address that resolved inside this area
        // still points at it, and a delete would either fail on the reference or
        // orphan the address out of the shop.
        await prisma.serviceArea.update({
          where: { id: entry.area.id },
          data: { isActive: false },
        })
        process.stdout.write(`\n  retired  ${entry.area.code}  ${entry.area.nameFa}`)
      }
      if (colliding.length > 0) {
        process.stdout.write(
          '\n\nAddresses that resolved inside a retired area keep pointing at it. They\n' +
            'still deliver, but the area is gone from the shop — re-save any address\n' +
            'that should now resolve into one of the new ones.\n',
        )
      }

      process.stdout.write(
        '\nThese boundaries are circles around approximate town centres, not surveyed\n' +
          'limits. Check every centre against a map, then refine the shapes from the\n' +
          'admin panel against real deliveries.\n' +
          'Branches must be created in this city and this zone, or no order can reach them.\n',
      )
      return
    }

    /**
     * Every service area this tenant has, and which zone each sits in.
     *
     * It used to filter on the literal zone code `BABOL_CATCHMENT`, which made
     * it answer "No coverage provisioned" to a tenant whose eight areas were
     * sitting right there under a zone its bootstrap had named something else —
     * advice to run a command that had already run. Narrowing is a flag now,
     * and the zone is a column rather than an assumption.
     */
    if (command === 'list-coverage') {
      const areas = await prisma.serviceArea.findMany({
        where: {
          tenantId,
          ...(flags['zone-code'] && { operationalZone: { is: { code: flags['zone-code'] } } }),
        },
        orderBy: [{ operationalZone: { code: 'asc' } }, { code: 'asc' }],
        include: { operationalZone: { include: { city: true } } },
      })
      if (areas.length === 0) {
        process.stdout.write('No coverage provisioned. Run provision-coverage first.\n')
        return
      }
      for (const area of areas) {
        const vehicle = area.motorcycleAllowed ? 'motorcycle+car' : 'car only'
        const state = area.isActive ? 'active' : 'inactive'
        process.stdout.write(
          `${area.operationalZone.city.code.padEnd(12)} ${area.operationalZone.code.padEnd(16)} ` +
            `${area.code.padEnd(20)} ${area.nameFa.padEnd(22)} ${vehicle.padEnd(16)} ${state}\n`,
        )
      }
      return
    }

    /**
     * Publishes a delivery tariff, through the service the admin panel calls.
     *
     * The panel can already do this, and this command exists anyway for the
     * same reason `configure-routing-provider` does: the tariff a shop opens
     * with has to be set before anybody has a browser pointed at the panel, and
     * it has to be set the same way afterwards. Going through
     * `publishTariff` rather than writing the row means a tariff made from a
     * shell supersedes its predecessor, carries a version, and is refused for
     * the same reasons a tariff made from the panel is refused.
     *
     * Scope is the pair (city, zone, vehicle); leaving `--zone` off publishes a
     * city-wide tariff, which is the right shape for a car rate — the selection
     * rule falls back from a zone's tariff to the city's, so one car rate covers
     * every zone that has not priced its own.
     *
     * Amounts are Rial, like everything the ledger touches.
     */
    if (command === 'publish-tariff') {
      const pricingService = createPrismaAdminDeliveryPricingService(prisma)
      const cityCode = required(flags, 'city-code')
      const city = await prisma.city.findFirst({
        where: { tenantId, code: cityCode },
        select: { id: true, nameFa: true },
      })
      if (!city) throw new Error(`No city ${cityCode} in this tenant`)

      let operationalZoneId: string | undefined
      if (flags['zone-code']) {
        const zone = await prisma.operationalZone.findFirst({
          where: { tenantId, cityId: city.id, code: flags['zone-code'] },
          select: { id: true },
        })
        if (!zone) throw new Error(`No zone ${flags['zone-code']} in city ${cityCode}`)
        operationalZoneId = zone.id
      }

      const vehicleProfile = (flags['vehicle'] ?? 'CAR').toUpperCase()
      if (vehicleProfile !== 'CAR' && vehicleProfile !== 'MOTORCYCLE') {
        throw new Error('--vehicle must be CAR or MOTORCYCLE')
      }
      const calculationMode = (flags['mode'] ?? 'DISTANCE_BANDED').toUpperCase()
      if (calculationMode !== 'FLAT' && calculationMode !== 'DISTANCE_BANDED') {
        throw new Error('--mode must be FLAT or DISTANCE_BANDED')
      }

      try {
        const tariff = await pricingService.publishTariff(
          tenantId,
          {
            cityId: city.id,
            ...(operationalZoneId && { operationalZoneId }),
            vehicleProfile,
            calculationMode,
            baseFeeAmount: BigInt(required(flags, 'base-rial')),
            perKilometerFeeAmount: BigInt(flags['per-km-rial'] ?? '0'),
            ...(flags['minimum-order-rial'] && {
              minimumOrderAmount: BigInt(flags['minimum-order-rial']),
            }),
            ...(flags['free-delivery-rial'] && {
              freeDeliveryThreshold: BigInt(flags['free-delivery-rial']),
            }),
          },
          now,
        )
        process.stdout.write(
          `Tariff published\n  city: ${city.nameFa}\n  vehicle: ${tariff.vehicleProfile}\n` +
            `  mode: ${tariff.calculationMode}\n  version: ${tariff.version}\n` +
            `  base: ${tariff.baseFeeAmount} Rial\n  perKm: ${tariff.perKilometerFeeAmount} Rial\n`,
        )
        process.stdout.write('The previous version of this tariff, if any, is now inactive.\n')
      } catch (error) {
        if (error instanceof AdminDeliveryPricingError) {
          throw new Error(`Tariff refused: ${error.code}`)
        }
        throw error
      }
      return
    }

    if (command === 'list-tariffs') {
      const pricingService = createPrismaAdminDeliveryPricingService(prisma)
      const tariffs = await pricingService.listTariffs(tenantId)
      if (tariffs.length === 0) {
        process.stdout.write('No delivery tariff is published. No order can be priced.\n')
        return
      }
      for (const tariff of tariffs) {
        const scope = tariff.operationalZoneNameFa ?? 'city-wide'
        const state = tariff.isActive ? 'active' : 'superseded'
        process.stdout.write(
          `${tariff.vehicleProfile.padEnd(11)} ${tariff.calculationMode.padEnd(16)} ` +
            `v${String(tariff.version).padEnd(3)} base=${tariff.baseFeeAmount.padStart(9)} ` +
            `perKm=${tariff.perKilometerFeeAmount.padStart(8)} ${state.padEnd(11)} ` +
            `${tariff.cityNameFa} / ${scope}\n`,
        )
      }
      return
    }

    if (command === 'list-routing-providers') {
      const configurations = await routingService.listConfigurations(
        tenantId,
        { actor: 'SYSTEM' },
        now,
      )
      if (configurations.length === 0) {
        process.stdout.write(
          'No routing provider is configured. Delivery distance is the scaled straight line.\n',
        )
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

    if (command === 'set-routing-provider-health') {
      const configuration = await routingService.setConfigurationHealth(
        tenantId,
        {
          actor: 'SYSTEM',
          configurationId: required(flags, 'configuration'),
          // UNKNOWN is not offered: nothing may claim an engine was never
          // observed once it has been. The service raises governanceVersion,
          // which is what stops two concurrent operators from silently
          // overwriting each other's decision about an engine.
          healthStatus: required(flags, 'health').toUpperCase() as
            'HEALTHY' | 'DEGRADED' | 'UNHEALTHY',
          reason: required(flags, 'reason'),
        },
        now,
        correlationId,
      )
      process.stdout.write(
        `Routing provider health is now ${configuration.healthStatus} for ${configuration.providerCode}\n`,
      )
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
