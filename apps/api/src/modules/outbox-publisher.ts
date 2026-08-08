import type { PrismaClient } from '@alo-noon/database'

import type { CustomerNotificationService } from './customer-notifications.js'

/**
 * Drains the domain event outbox.
 *
 * Until now these rows accumulated and nothing ever read them, which made the
 * outbox a write-only log with a `status` column that was always PENDING. This
 * turns it into what it was written to be.
 *
 * Ordering is by `occurredAt` within a tenant, so a customer is not told their
 * order is on its way before being told it was accepted. Rows are claimed a
 * bounded batch at a time: a backlog after an outage should drain steadily
 * rather than become a burst of texts and a load test against the same database
 * checkout is running on.
 *
 * A handler that fails leaves the row PENDING so the next sweep retries it,
 * until `maxAttempts` — past which the row is marked FAILED and left alone. A
 * poison event retried forever would block every event behind it for that
 * tenant, and the thing behind it is somebody's order.
 */
export interface OutboxPublisher {
  publish(tenantId: string, batchSize: number, now: Date): Promise<OutboxPublishSummary>
}

export interface OutboxPublishSummary {
  readonly claimed: number
  readonly published: number
  readonly failed: number
  readonly retrying: number
}

export interface OutboxPublisherOptions {
  readonly notificationService: CustomerNotificationService
  /** After this many tries a row is parked so it stops blocking the queue. */
  readonly maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 5

export function createPrismaOutboxPublisher(
  prisma: PrismaClient,
  options: OutboxPublisherOptions,
): OutboxPublisher {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  return {
    async publish(tenantId, batchSize, now) {
      const events = await prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        return transaction.domainEventOutbox.findMany({
          where: { tenantId, status: 'PENDING' },
          orderBy: { occurredAt: 'asc' },
          take: batchSize,
        })
      })

      let published = 0
      let failed = 0
      let retrying = 0

      for (const event of events) {
        const attempts = event.publishAttempts + 1
        let handled: boolean
        let errorCode: string
        try {
          const outcome = await options.notificationService.notify(
            tenantId,
            {
              name: event.name,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              payload: (event.payload ?? {}) as Readonly<Record<string, unknown>>,
              correlationId: event.correlationId,
            },
            now,
          )
          // An event nobody needed to act on is as published as one that sent a
          // message. Most domain events are not things a customer wants a text
          // about, and leaving them pending forever would hide the ones that are.
          handled = outcome !== 'FAILED'
          errorCode = outcome
        } catch {
          handled = false
          errorCode = 'HANDLER_THREW'
        }

        const exhausted = !handled && attempts >= maxAttempts
        await prisma.$transaction(async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
          await transaction.domainEventOutbox.update({
            where: { id: event.id },
            data: {
              publishAttempts: attempts,
              ...(handled
                ? { status: 'PUBLISHED', publishedAt: now, lastErrorCode: null }
                : {
                    ...(exhausted && { status: 'FAILED' as const }),
                    lastErrorCode: errorCode.slice(0, 64),
                  }),
            },
          })
        })

        if (handled) published += 1
        else if (exhausted) failed += 1
        else retrying += 1
      }

      return { claimed: events.length, published, failed, retrying }
    },
  }
}
