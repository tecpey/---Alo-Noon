/**
 * The database package's public face.
 *
 * Every application in this repository reaches Prisma through here — eighty
 * files import this barrel and four import Prisma directly — which is what made
 * the move to version 7 a contained change rather than a sweep. The generated
 * client no longer lives in `node_modules`; it is written to `generated/client`
 * and imported by path, and this file is the only place that path is named.
 */
import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient as GeneratedPrismaClient } from '../generated/client/client'

export { Prisma } from '../generated/client/client'

export { readDatabaseFailure, isRetryableDatabaseFailure } from './failure'
export type { DatabaseFailure } from './failure'

/**
 * A client that already knows how to connect.
 *
 * Version 7 removed the Rust query engine and made a driver adapter mandatory,
 * so `new PrismaClient()` with no argument is no longer a working client. Rather
 * than thread an adapter through the forty-three places that construct one —
 * most of them integration tests — the default is supplied here, and every one
 * of those call sites carries on saying `new PrismaClient()`.
 *
 * The connection string is read at construction rather than at import, so a
 * test that sets `DATABASE_URL` in its own setup still gets the database it
 * asked for.
 */
export class PrismaClient extends GeneratedPrismaClient {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }) })
  }
}

export type {
  Address,
  AccessGrant,
  AuthSession,
  AuthAbuseEvent,
  AuthDeliveryProviderConfiguration,
  AuthOtpChallenge,
  AuthOtpDeliveryAttempt,
  AuthorizationPermission,
  AuthorizationRole,
  Bakery,
  BakeryBranch,
  BakeryProductOffering,
  Cart,
  CartItem,
  City,
  Courier,
  Customer,
  DeliveryTask,
  DomainEventOutbox,
  Fulfillment,
  Household,
  HouseholdMember,
  IdentityAccount,
  OperationalZone,
  Order,
  OrderItem,
  OrderStateTransition,
  OtpChallenge,
  Product,
  ProductVariant,
  Quote,
  QuoteItem,
  Payment,
  PaymentStateTransition,
  ProviderCredentialReference,
  PaymentProviderConfiguration,
  PaymentProviderGovernanceEvent,
  PaymentAttempt,
  PaymentAttemptStateTransition,
  PaymentCallbackReceipt,
  LedgerAccount,
  LedgerAccountGovernanceEvent,
  TenantFinancialBootstrap,
  FinancialTransaction,
  LedgerEntry,
  Vehicle,
} from '../generated/client/client'
