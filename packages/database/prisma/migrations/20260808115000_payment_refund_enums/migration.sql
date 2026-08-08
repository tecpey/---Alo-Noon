-- Enum values only, in their own migration.
--
-- Postgres will not let a newly added enum value be used in the same
-- transaction that added it, and Prisma runs each migration file in one
-- transaction. Splitting these out is what lets the next migration reference
-- them in a check constraint.
ALTER TYPE "PaymentAggregateState" ADD VALUE IF NOT EXISTS 'REFUNDED' AFTER 'CAPTURED';
ALTER TYPE "FinancialTransactionType" ADD VALUE IF NOT EXISTS 'PAYMENT_REFUND';
