/**
 * The last thing anybody runs before the shop opens.
 *
 * Every other drive in this directory asks whether the code works. This asks
 * whether *this deployment* is ready to take a stranger's money, and it asks it
 * on the machine that will. The difference matters: all six of the things below
 * are configuration, all six are a human's to get right, and every one of them
 * has a failure mode that is invisible until a customer hits it.
 *
 * It reads and never writes. It contacts no gateway and sends no message — a
 * preflight that spends the shop's SMS credit is a preflight nobody runs twice.
 * Where it can only check that something is *set* rather than *correct*, it says
 * so rather than implying more than it knows.
 *
 *     DATABASE_URL=… pnpm --filter @alo-noon/api exec tsx scripts/launch-preflight.ts
 *
 * Exit 0 means every blocking check passed. Warnings do not fail it: they are
 * the decisions a launch can knowingly take, and the point is that they are
 * taken rather than missed.
 */
import { PrismaClient } from '@alo-noon/database'

const TENANT = process.env['LAUNCH_TENANT_ID'] ?? '00000000-0000-4000-8000-000000000001'

let blocking = 0
let warnings = 0

function ok(label: string, detail = ''): void {
  process.stdout.write(`  [ok]    ${label}${detail ? ` — ${detail}` : ''}\n`)
}
function stop(label: string, detail: string): void {
  blocking += 1
  process.stdout.write(`  [STOP]  ${label} — ${detail}\n`)
}
function warn(label: string, detail: string): void {
  warnings += 1
  process.stdout.write(`  [warn]  ${label} — ${detail}\n`)
}
function section(title: string): void {
  process.stdout.write(`\n${title}\n`)
}

const prisma = new PrismaClient()

/** Everything below reads this tenant, so RLS is set once for the whole run. */
async function asTenant<T>(work: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, false)`, TENANT)
  return work()
}

async function main(): Promise<void> {
  process.stdout.write(`=== Launch preflight for tenant ${TENANT} ===\n`)

  section('Can anybody pay?')
  await asTenant(async () => {
    const gateways = await prisma.paymentProviderConfiguration.findMany({
      where: { tenantId: TENANT },
      select: {
        providerCode: true,
        environment: true,
        isActive: true,
        isDefault: true,
        healthStatus: true,
        merchantReference: true,
      },
    })
    const usable = gateways.filter(
      (gateway) => gateway.isActive && gateway.healthStatus === 'HEALTHY',
    )
    if (gateways.length === 0) {
      // Both ways to pay end at a gateway: the bank, and topping up the wallet
      // that the other way spends. Without one, an order is placed and stays
      // PENDING_CONFIRMATION forever.
      stop('no payment gateway is configured', 'nobody can pay — see گام ۲ of the operations guide')
    } else if (usable.length === 0) {
      stop(
        'a gateway exists but none is active and healthy',
        gateways
          .map((g) => `${g.providerCode}: active=${g.isActive} health=${g.healthStatus}`)
          .join(', '),
      )
    } else {
      const live = usable.filter((gateway) => gateway.environment === 'PRODUCTION')
      if (live.length === 0) {
        stop(
          'every configured gateway is in TEST',
          'a TEST merchant takes no real money — set --environment PRODUCTION',
        )
      } else {
        ok(
          'a gateway is live',
          live.map((g) => `${g.providerCode} (${g.merchantReference})`).join(', '),
        )
      }
      if (!usable.some((gateway) => gateway.isDefault)) {
        warn('no gateway is marked default', 'selection will fall back and may be arbitrary')
      }
    }
  })

  section('Can anybody sign in?')
  {
    const key = process.env['AUTH_SMS_LIMOSMS_KEY']
    if (!key) {
      stop(
        'AUTH_SMS_LIMOSMS_KEY is not set',
        'no one-time code can be delivered, so nobody signs in',
      )
    } else if (/sandbox|test|not-a-real|changeme|example/i.test(key)) {
      // The exact string the drives use. Shipping it means every sign-in fails
      // silently at the provider.
      stop(
        'AUTH_SMS_LIMOSMS_KEY still looks like a sandbox value',
        'issue a real key from the panel',
      )
    } else {
      ok('an SMS key is set', `${key.length} characters`)
      warn(
        'the SMS key cannot be verified from here',
        'send yourself one code before opening, and confirm it arrives',
      )
    }
    const endpoint = process.env['AUTH_SMS_LIMOSMS_ENDPOINT']
    if (endpoint && /127\.0\.0\.1|localhost/.test(endpoint)) {
      stop('AUTH_SMS_LIMOSMS_ENDPOINT points at the local sandbox', endpoint)
    }
  }

  section('Will the gateway be able to send the customer back?')
  {
    const callback = process.env['PAYMENT_CALLBACK_BASE_URL']
    const result = process.env['PAYMENT_RESULT_REDIRECT_URL']
    if (!callback || !result) {
      // The pair the server now enforces together. Half of it registers no
      // adapter at all, which fails safely — and silently.
      stop(
        'the payment callback pair is incomplete',
        `callback=${callback ? 'set' : 'MISSING'} result=${result ? 'set' : 'MISSING'} — online payment is disabled`,
      )
    } else if (!callback.startsWith('https://') || !result.startsWith('https://')) {
      stop('the callback pair is not HTTPS', 'a customer would return over plaintext')
    } else {
      ok('the callback pair is set and HTTPS', new URL(callback).host)
    }
  }

  section('Does the shop know where it is?')
  await asTenant(async () => {
    const hosts = await prisma.tenantDomain.findMany({
      where: { tenantId: TENANT },
      select: { host: true, isPrimary: true },
    })
    const primary = hosts.filter((host: { isPrimary: boolean }) => host.isPrimary)
    if (hosts.length === 0) stop('no host is registered for this tenant', 'every request would 404')
    else if (primary.length !== 1) {
      stop(
        `${primary.length} hosts are marked primary`,
        hosts.map((h: { host: string }) => h.host).join(', '),
      )
    } else {
      ok('the primary host is registered', primary[0]!.host)
      if (hosts.some((host: { host: string }) => /localhost|127\.0\.0\.1/.test(host.host))) {
        warn('a loopback host is registered', 'harmless, but it is development residue')
      }
    }
  })

  section('Is there anything to sell, and anywhere to take it?')
  await asTenant(async () => {
    const [zones, tariffs, couriers, offerings] = await Promise.all([
      prisma.operationalZone.count({ where: { tenantId: TENANT, isActive: true } }),
      prisma.deliveryPricingRule.count({ where: { tenantId: TENANT, isActive: true } }),
      prisma.courier.count({ where: { tenantId: TENANT, status: 'AVAILABLE' } }),
      prisma.bakeryProductOffering.count({
        where: { tenantId: TENANT, availability: 'AVAILABLE' },
      }),
    ])
    if (zones === 0) stop('no active coverage zone', 'every address would be refused')
    else ok('coverage zones', String(zones))
    if (tariffs === 0) stop('no active delivery tariff', 'no order can be priced')
    else ok('delivery tariffs', String(tariffs))
    if (offerings === 0) stop('nothing is on the shelf', 'the storefront would be empty')
    else ok('active offerings', String(offerings))
    if (couriers === 0) stop('no courier is available', 'an accepted order could not be dispatched')
    else ok('available couriers', String(couriers))

    // Checked, because it has been wrong once and cost ten times the fare.
    warn(
      'tariff figures cannot be verified from here',
      'confirm the car tariff against a real invoice before opening car orders',
    )
  })

  section('What happens if the disk dies tonight?')
  await asTenant(async () => {
    const orders = await prisma.order.count({ where: { tenantId: TENANT } })
    ok('orders currently held', String(orders))
    warn(
      'backups cannot be verified from here',
      'confirm deploy/backup.sh is on a timer and run deploy/restore-drill.sh once',
    )
  })

  section('Is anything still pointed at a sandbox?')
  {
    const sandboxed = Object.entries(process.env).filter(
      ([name, value]) =>
        /ENDPOINT|BASE_URL|_URL$/.test(name) &&
        typeof value === 'string' &&
        /127\.0\.0\.1|localhost|:4010|:4180|:4443/.test(value),
    )
    if (sandboxed.length === 0) ok('nothing points at loopback')
    else
      for (const [name, value] of sandboxed) {
        stop(`${name} points at loopback`, String(value))
      }
  }

  process.stdout.write(
    blocking === 0
      ? `\nCLEARED FOR LAUNCH — ${warnings} thing(s) only a human can confirm.\n`
      : `\nNOT READY: ${blocking} blocking, ${warnings} to confirm.\n`,
  )
  if (blocking > 0) process.exitCode = 1
}

main()
  .catch((error: unknown) => {
    process.stdout.write(`\nPREFLIGHT ABORTED: ${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
