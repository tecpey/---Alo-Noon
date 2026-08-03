import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../prisma/migrations/20260804100000_payment_execution_orchestrator/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('payment execution orchestrator migration', () => {
  it('is additive, nullable, and contains no economic rewrite', () => {
    expect(migration).toContain('CREATE TYPE "PaymentInitializationOutcome"')
    expect(migration).toContain('ADD COLUMN "initializationOutcome"')
    expect(migration).not.toMatch(
      /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE "Payment"|UPDATE "Order"/,
    )
    expect(migration).not.toMatch(/DEFAULT.*ACCEPTED|DEFAULT.*FAILED/)
  })

  it('keeps normalized execution output consistent and immutable', () => {
    expect(migration).toContain('PaymentAttempt_initialization_result_check')
    expect(migration).toContain('PaymentAttempt_customer_message_key_check')
    expect(migration).toContain('OLD."initializationOutcome" IS NOT NULL')
    expect(migration).toContain('initialization result is immutable')
  })

  it('extends committed audit and outbox enforcement for initialization events', () => {
    expect(migration).toContain('payment.execution_requested')
    expect(migration).toContain('payment.attempt_initialization_started')
    expect(migration).toContain('payment.attempt_initialized')
    expect(migration).toContain('payment.customer_action_required')
    expect(migration).toContain('payment.attempt_initialization_failed')
    expect(migration).toContain(
      'Payment attempt transitions require committed audit and outbox records',
    )
  })
})
