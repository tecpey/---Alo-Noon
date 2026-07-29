-- Phase 2B identity, revocable session, and scoped authorization foundation.
-- Raw OTP codes and session tokens are never stored; only keyed digests are persisted.

CREATE TYPE "IdentityAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "OtpChallengeStatus" AS ENUM ('PENDING', 'CONSUMED', 'INVALIDATED');
CREATE TYPE "AuthorizationScopeType" AS ENUM (
  'GLOBAL',
  'CITY',
  'OPERATIONAL_ZONE',
  'BAKERY_BRANCH',
  'COURIER_PARTNER',
  'SELF'
);

CREATE TABLE "IdentityAccount" (
  "id" UUID NOT NULL,
  "mobileE164" VARCHAR(16) NOT NULL,
  "customerId" UUID,
  "status" "IdentityAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OtpChallenge" (
  "id" UUID NOT NULL,
  "mobileE164" VARCHAR(16) NOT NULL,
  "codeDigest" VARCHAR(64) NOT NULL,
  "status" "OtpChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resendAvailableAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "invalidatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OtpChallenge_attempt_bounds_check"
    CHECK ("attempts" >= 0 AND "maxAttempts" > 0 AND "attempts" <= "maxAttempts"),
  CONSTRAINT "OtpChallenge_time_order_check"
    CHECK ("resendAvailableAt" <= "expiresAt")
);

CREATE TABLE "AuthSession" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "tokenDigest" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthorizationRole" (
  "id" UUID NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthorizationRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthorizationPermission" (
  "id" UUID NOT NULL,
  "code" VARCHAR(100) NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthorizationPermission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RolePermission" (
  "roleId" UUID NOT NULL,
  "permissionId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId")
);

CREATE TABLE "AccessGrant" (
  "id" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "scopeType" "AuthorizationScopeType" NOT NULL,
  "scopeId" UUID,
  "activeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccessGrant_scope_shape_check"
    CHECK (
      ("scopeType" = 'GLOBAL' AND "scopeId" IS NULL)
      OR ("scopeType" <> 'GLOBAL' AND "scopeId" IS NOT NULL)
    ),
  CONSTRAINT "AccessGrant_expiry_check"
    CHECK ("expiresAt" IS NULL OR "expiresAt" > "activeAt")
);

CREATE UNIQUE INDEX "IdentityAccount_mobileE164_key" ON "IdentityAccount"("mobileE164");
CREATE UNIQUE INDEX "IdentityAccount_customerId_key" ON "IdentityAccount"("customerId");
CREATE INDEX "IdentityAccount_status_createdAt_idx" ON "IdentityAccount"("status", "createdAt");
CREATE INDEX "OtpChallenge_mobileE164_createdAt_idx" ON "OtpChallenge"("mobileE164", "createdAt");
CREATE INDEX "OtpChallenge_status_expiresAt_idx" ON "OtpChallenge"("status", "expiresAt");
CREATE UNIQUE INDEX "AuthSession_tokenDigest_key" ON "AuthSession"("tokenDigest");
CREATE INDEX "AuthSession_accountId_revokedAt_expiresAt_idx"
  ON "AuthSession"("accountId", "revokedAt", "expiresAt");
CREATE UNIQUE INDEX "AuthorizationRole_code_key" ON "AuthorizationRole"("code");
CREATE UNIQUE INDEX "AuthorizationPermission_code_key" ON "AuthorizationPermission"("code");
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");
CREATE INDEX "AccessGrant_accountId_revokedAt_expiresAt_idx"
  ON "AccessGrant"("accountId", "revokedAt", "expiresAt");
CREATE INDEX "AccessGrant_scopeType_scopeId_idx" ON "AccessGrant"("scopeType", "scopeId");

ALTER TABLE "IdentityAccount"
  ADD CONSTRAINT "IdentityAccount_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "IdentityAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission"
  ADD CONSTRAINT "RolePermission_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "AuthorizationRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission"
  ADD CONSTRAINT "RolePermission_permissionId_fkey"
  FOREIGN KEY ("permissionId") REFERENCES "AuthorizationPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessGrant"
  ADD CONSTRAINT "AccessGrant_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "IdentityAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessGrant"
  ADD CONSTRAINT "AccessGrant_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "AuthorizationRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
