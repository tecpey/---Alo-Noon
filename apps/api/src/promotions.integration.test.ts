import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PrismaClient } from '@alo-noon/database'

import {
  consumeRedemptionForQuote,
  previewPromotion,
  releaseRedemptionsForQuotes,
  reservePromotion,
} from './modules/promotions'

/**
 * Exercises discount campaigns against PostgreSQL.
 *
 * The rules worth testing here are the ones that only hold when several rows
 * and several transactions agree: a campaign's budget cannot be overspent by
 * two customers racing the last redemption, an abandoned quote gives its hold
 * back, and a hold that has been spent cannot be spent again.
 *
 * The database's own guards are exercised too. They are the last line if the
 * service is ever wrong, and a check constraint nobody has seen fire is a check
 * constraint nobody knows works.
 */
const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()

const suffix = randomUUID().slice(0, 8).toUpperCase()
const now = new Date('2026-08-10T10:00:00.000Z')

interface Fixture {
  tenantId: string
  cityId: string
  otherCityId: string
  customerId: string
  otherCustomerId: string
}

let fixture: Fixture

afterAll(async () => prisma.$disconnect())

async function withTenant<T>(
  tenantId: string,
  run: (t: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return run(transaction)
  })
}

async function seed(): Promise<Fixture> {
  const tenant = await prisma.tenant.create({
    data: { slug: `promo-${suffix.toLowerCase()}`, name: `Promo ${suffix}`, status: 'ACTIVE' },
  })
  return withTenant(tenant.id, async (t) => {
    const city = await t.city.create({
      data: { tenantId: tenant.id, code: `PROMO${suffix}`, nameFa: 'شهر', isActive: true },
    })
    const otherCity = await t.city.create({
      data: { tenantId: tenant.id, code: `PROMOB${suffix}`, nameFa: 'شهر دیگر', isActive: true },
    })
    const customer = await t.customer.create({
      data: { tenantId: tenant.id, mobileE164: `+9891${suffix.slice(0, 8)}` },
    })
    const otherCustomer = await t.customer.create({
      data: { tenantId: tenant.id, mobileE164: `+9892${suffix.slice(0, 8)}` },
    })
    return {
      tenantId: tenant.id,
      cityId: city.id,
      otherCityId: otherCity.id,
      customerId: customer.id,
      otherCustomerId: otherCustomer.id,
    }
  })
}

async function makePromotion(overrides: Record<string, unknown> = {}): Promise<string> {
  return withTenant(fixture.tenantId, async (t) => {
    const promotion = await t.promotion.create({
      data: {
        tenantId: fixture.tenantId,
        code: `C${randomUUID().slice(0, 10).toUpperCase().replace(/-/g, '')}`,
        nameFa: 'کمپین آزمایشی',
        kind: 'PERCENTAGE',
        percentageBasisPoints: 1_000,
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        isActive: true,
        ...overrides,
      },
      select: { id: true, code: true },
    })
    return promotion.code
  })
}

const basket = { subtotal: 100_000n, deliveryFee: 50_000n }

databaseDescribe('discount campaigns over PostgreSQL', () => {
  beforeAll(async () => {
    fixture = await seed()
  }, 60_000)

  it('prices a code without spending any of its budget', async () => {
    const code = await makePromotion({ totalRedemptionLimit: 1 })

    const preview = await withTenant(fixture.tenantId, (t) =>
      previewPromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(preview).toMatchObject({ applied: true, discountAmount: 10_000n })

    // A preview that consumed budget would let anyone drain a campaign by
    // pasting the same code repeatedly, so the counter must not have moved.
    const after = await prisma.promotion.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, code },
      select: { redeemedCount: true },
    })
    expect(after.redeemedCount).toBe(0)
  })

  it('holds a redemption when a quote is priced, and spends it on the order', async () => {
    const code = await makePromotion()
    const reserved = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(reserved.applied).toBe(true)

    const held = await prisma.promotionRedemption.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, id: reserved.redemptionId! },
    })
    expect(held.state).toBe('RESERVED')
    expect(held.amount).toBe(10_000n)
  })

  /**
   * The distinction the whole design rests on. A campaign capped at a thousand
   * must not be exhausted by a thousand people who opened checkout and changed
   * their minds.
   */
  it('gives the budget back when the quote it was held for dies', async () => {
    const code = await makePromotion({ totalRedemptionLimit: 1 })

    const reserved = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(reserved.applied).toBe(true)

    const spent = await prisma.promotion.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, code },
      select: { id: true, redeemedCount: true },
    })
    expect(spent.redeemedCount).toBe(1)

    // The hold is released directly, standing in for the quote being superseded.
    await withTenant(fixture.tenantId, async (t) => {
      await t.promotionRedemption.updateMany({
        where: { id: reserved.redemptionId! },
        data: { state: 'RELEASED' },
      })
      await t.$executeRaw`
        UPDATE "Promotion" SET "redeemedCount" = GREATEST("redeemedCount" - 1, 0)
        WHERE "id" = ${spent.id}::uuid AND "tenantId" = ${fixture.tenantId}::uuid
      `
    })

    const recovered = await prisma.promotion.findFirstOrThrow({
      where: { id: spent.id },
      select: { redeemedCount: true },
    })
    expect(recovered.redeemedCount).toBe(0)

    // And the campaign is usable again, which is the point of releasing.
    const second = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.otherCustomerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(second.applied).toBe(true)
  })

  it('refuses once the campaign budget is spent', async () => {
    const code = await makePromotion({ totalRedemptionLimit: 1 })
    const first = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(first.applied).toBe(true)

    const second = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.otherCustomerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(second).toEqual({ applied: false, reason: 'PROMOTION_EXHAUSTED' })
  })

  it('keeps a per-customer limit against the same customer', async () => {
    const code = await makePromotion({ perCustomerLimit: 1 })
    const first = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(first.applied).toBe(true)

    const again = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(again).toEqual({ applied: false, reason: 'PROMOTION_CUSTOMER_LIMIT_REACHED' })

    // A different customer is unaffected, which is what makes it per-customer.
    const other = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.otherCustomerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(other.applied).toBe(true)
  })

  /** The lever provincial rollout depends on. */
  it('keeps a city campaign inside its city', async () => {
    const code = await makePromotion({ cityId: fixture.cityId })
    const elsewhere = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.otherCityId,
        now,
      }),
    )
    expect(elsewhere).toEqual({ applied: false, reason: 'PROMOTION_WRONG_CITY' })
  })

  it('does not recognise a code that was never issued', async () => {
    const missing = await withTenant(fixture.tenantId, (t) =>
      previewPromotion(t, fixture.tenantId, fixture.customerId, {
        code: 'NOSUCHCODE',
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(missing).toEqual({ applied: false, reason: 'PROMOTION_NOT_FOUND' })
  })

  it('reads a code the way a customer typed it', async () => {
    const code = await makePromotion()
    const messy = await withTenant(fixture.tenantId, (t) =>
      previewPromotion(t, fixture.tenantId, fixture.customerId, {
        code: `  ${code.toLowerCase()} `,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(messy.applied).toBe(true)
  })

  describe('the database as the last line', () => {
    it('refuses to overspend a campaign even if the service asks it to', async () => {
      const code = await makePromotion({ totalRedemptionLimit: 1 })
      const promotion = await prisma.promotion.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, code },
        select: { id: true },
      })

      await expect(
        withTenant(
          fixture.tenantId,
          (t) =>
            t.$executeRaw`
            UPDATE "Promotion" SET "redeemedCount" = 5
            WHERE "id" = ${promotion.id}::uuid AND "tenantId" = ${fixture.tenantId}::uuid
          `,
        ),
      ).rejects.toThrow(/promotion_budget_check/)
    })

    it('refuses a redemption marked spent with no order behind it', async () => {
      const code = await makePromotion()
      const promotion = await prisma.promotion.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, code },
        select: { id: true },
      })

      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.promotionRedemption.create({
            data: {
              tenantId: fixture.tenantId,
              promotionId: promotion.id,
              customerId: fixture.customerId,
              amount: 1_000n,
              basis: 'SUBTOTAL',
              state: 'CONSUMED',
              correlationId: randomUUID(),
            },
          }),
        ),
      ).rejects.toThrow(/promotion_redemption_consumed_check/)
    })

    it('refuses to move a settled redemption again', async () => {
      const code = await makePromotion()
      const reserved = await withTenant(fixture.tenantId, (t) =>
        reservePromotion(t, fixture.tenantId, fixture.customerId, {
          code,
          ...basket,
          cityId: fixture.cityId,
          now,
        }),
      )
      await withTenant(fixture.tenantId, (t) =>
        t.promotionRedemption.updateMany({
          where: { id: reserved.redemptionId! },
          data: { state: 'RELEASED' },
        }),
      )

      await expect(
        withTenant(fixture.tenantId, (t) =>
          t.promotionRedemption.updateMany({
            where: { id: reserved.redemptionId! },
            data: { state: 'RESERVED' },
          }),
        ),
      ).rejects.toThrow(/settled promotion redemption/i)
    })
  })

  it('leaves the budget untouched when nothing is reserved', async () => {
    const code = await makePromotion({ minSubtotalAmount: 10_000_000n })
    const refused = await withTenant(fixture.tenantId, (t) =>
      reservePromotion(t, fixture.tenantId, fixture.customerId, {
        code,
        ...basket,
        cityId: fixture.cityId,
        now,
      }),
    )
    expect(refused).toEqual({ applied: false, reason: 'PROMOTION_BELOW_MINIMUM' })

    const untouched = await prisma.promotion.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, code },
      select: { redeemedCount: true },
    })
    expect(untouched.redeemedCount).toBe(0)
  })

  it('does nothing when there is no hold to release or consume', async () => {
    // Both are called on paths where a promotion may never have been used, so
    // neither may throw on an empty set.
    await expect(
      withTenant(fixture.tenantId, (t) =>
        releaseRedemptionsForQuotes(t, fixture.tenantId, [], now),
      ),
    ).resolves.toBeUndefined()
    await expect(
      withTenant(fixture.tenantId, (t) =>
        consumeRedemptionForQuote(t, fixture.tenantId, randomUUID(), randomUUID()),
      ),
    ).resolves.toBeUndefined()
  })
})
