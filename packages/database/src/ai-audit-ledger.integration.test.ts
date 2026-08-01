import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseDescribe = process.env['DATABASE_URL'] ? describe : describe.skip
const prisma = new PrismaClient()
const tenantA = randomUUID()
const tenantB = randomUUID()
const roleName = `alo_noon_ai_audit_${randomUUID().replaceAll('-', '')}`
const eventId = randomUUID()
const proposalId = randomUUID()
const digest = (character: string): string => `sha256:${character.repeat(64)}`

databaseDescribe('governed AI durable audit G6B', () => {
  beforeAll(async () => {
    await prisma.tenant.createMany({
      data: [
        { id: tenantA, slug: `ai-a-${tenantA.slice(0, 8)}`, name: 'AI audit tenant A' },
        { id: tenantB, slug: `ai-b-${tenantB.slice(0, 8)}`, name: 'AI audit tenant B' },
      ],
    })
    await prisma.$executeRawUnsafe(`CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AiControlPlaneAuditEvent" TO "${roleName}"`,
    )
  })

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${roleName}"`)
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
    await prisma.$disconnect()
  })

  it('is deny-by-default and isolates audit rows by tenant', async () => {
    await prisma.$executeRaw`
      INSERT INTO "AiControlPlaneAuditEvent" (
        "id", "tenantId", "eventId", "proposalId", "sequence", "eventType", "agentRole",
        "action", "classification", "redactionStatus", "correlationId", "traceId",
        "charterVersion", "policyVersion", "modelProvider", "modelVersion", "provenanceUri",
        "payload", "payloadDigest", "eventDigest", "occurredAt", "retainedUntil"
      ) VALUES (
        ${randomUUID()}::uuid, ${tenantA}::uuid, ${eventId}::uuid, ${proposalId}::uuid, 1,
        'POLICY_DECIDED', 'CISO', 'DETECT', 'INTERNAL', 'REDACTED', ${randomUUID()}::uuid,
        'trace-0123456789abcdef', 'ciso-v1', 'ai-policy-v1', 'provider-abstract', 'model-v1',
        'policy://ai-policy-v1/decision', ${{ outcome: 'DENY' }}::jsonb,
        ${digest('a')}, ${digest('b')}, now(), now() + interval '1 year'
      )
    `

    const withoutContext = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      return transaction.$queryRaw<Array<{ eventId: string }>>`
        SELECT "eventId" FROM "AiControlPlaneAuditEvent"
      `
    })
    expect(withoutContext).toEqual([])

    const visible = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
      await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`
      return transaction.$queryRaw<Array<{ eventId: string }>>`
        SELECT "eventId" FROM "AiControlPlaneAuditEvent"
      `
    })
    expect(visible).toEqual([{ eventId }])
  })

  it('rejects cross-tenant writes, PII without redaction and mutation', async () => {
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
        await transaction.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`
        await transaction.$executeRaw`
          INSERT INTO "AiControlPlaneAuditEvent" (
            "id", "tenantId", "eventId", "proposalId", "sequence", "eventType", "agentRole",
            "action", "classification", "redactionStatus", "correlationId", "traceId",
            "charterVersion", "policyVersion", "modelProvider", "modelVersion", "provenanceUri",
            "payload", "payloadDigest", "eventDigest", "occurredAt", "retainedUntil"
          ) VALUES (
            ${randomUUID()}::uuid, ${tenantB}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
            1, 'REQUEST_RECEIVED', 'CISO', 'DETECT', 'PII', 'NOT_REQUIRED', ${randomUUID()}::uuid,
            'trace-fedcba9876543210', 'ciso-v1', 'ai-policy-v1', 'provider-abstract', 'model-v1',
            'request://blocked', ${{}}::jsonb, ${digest('c')}, ${digest('d')},
            now(), now() + interval '1 year'
          )
        `
      }),
    ).rejects.toThrow()

    await expect(
      prisma.$executeRaw`
        UPDATE "AiControlPlaneAuditEvent" SET "payload" = ${{ tampered: true }}::jsonb
        WHERE "eventId" = ${eventId}::uuid
      `,
    ).rejects.toThrow()
  })
})
