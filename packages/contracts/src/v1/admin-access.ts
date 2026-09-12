import { z } from 'zod'

import { isoDateTimeSchema, uuidSchema } from './common'

/**
 * Staff access management transport.
 *
 * Roles are named, not assembled: a command names a role code and the server
 * resolves which permissions that carries. Letting a caller send a permission
 * list would make every future permission a thing an existing operator could
 * quietly hand themselves.
 *
 * Mobile numbers identify the target because that is what an operator has —
 * someone's phone number, not their account UUID — and because signing in with
 * that number is what created the account in the first place.
 */
const mobileE164Schema = z
  .string()
  .regex(/^\+989\d{9}$/, 'Enter an Iranian mobile number in +989xxxxxxxxx form')

const roleCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'Unknown role')

const reasonSchema = z.string().min(3).max(280)

export const adminRoleSummarySchema = z.object({
  code: roleCodeSchema,
  name: z.string().min(1).max(120),
  permissions: z.array(z.string().min(1).max(100)),
  /**
   * How far the role reaches. `TENANT` roles are granted once and see the whole
   * tenant; `BAKERY_BRANCH` roles are granted against one branch and see that
   * branch. The panel needs this to know whether to ask which branch.
   */
  scope: z.enum(['TENANT', 'BAKERY_BRANCH']),
  /**
   * Whether the account asking may grant this role. False means the role
   * carries a permission the caller does not itself hold — the panel shows it
   * greyed rather than hiding it, so an operator can see what they would need.
   */
  grantable: z.boolean(),
})

export const staffMemberSchema = z.object({
  accountId: uuidSchema,
  mobileE164: z.string().min(4).max(16),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
  roles: z.array(
    z.object({
      grantId: uuidSchema,
      code: roleCodeSchema,
      name: z.string().min(1).max(120),
      grantedAt: isoDateTimeSchema,
      expiresAt: isoDateTimeSchema.nullable(),
      /** Present on a branch-scoped grant, naming the counter it reaches. */
      bakeryBranchId: uuidSchema.optional(),
      bakeryBranchNameFa: z.string().min(1).optional(),
    }),
  ),
  /** Union of every permission the account's live grants carry. */
  permissions: z.array(z.string().min(1).max(100)),
  /** True for the account making the request, which may not revoke itself. */
  isSelf: z.boolean(),
})

/**
 * What a branch picker may ask for.
 *
 * A tenant with one city has a handful of branches; a national one has
 * thousands, and a dropdown holding all of them is a wall rather than a list —
 * worst on the phone an operator is most likely holding. So the listing is
 * bounded and can be narrowed, and the response says how many matched.
 */
export const grantableBranchQuerySchema = z.object({
  // Two characters is where narrowing starts being narrowing. One would return
  // most of the tenant and read as a broken filter.
  search: z.string().trim().min(2).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const grantableBranchSchema = z.object({
  id: z.string().uuid(),
  nameFa: z.string().min(1).max(160),
  bakeryNameFa: z.string().min(1).max(160),
})

export const grantRoleCommandSchema = z
  .object({
    mobileE164: mobileE164Schema,
    roleCode: roleCodeSchema,
    /**
     * Required for a branch-scoped role, refused for a tenant one.
     *
     * Not defaulted either way. A branch role that quietly fell back to the
     * whole tenant would hand a bakery's counter every competitor's queue, and
     * that is not a mistake worth being convenient about.
     */
    bakeryBranchId: uuidSchema.optional(),
    reason: reasonSchema,
  })
  .strict()

export const revokeRoleCommandSchema = z
  .object({
    grantId: uuidSchema,
    reason: reasonSchema,
  })
  .strict()

export type GrantableBranchQuery = z.infer<typeof grantableBranchQuerySchema>
export type GrantableBranch = z.infer<typeof grantableBranchSchema>
export type AdminRoleSummary = z.infer<typeof adminRoleSummarySchema>
export type StaffMember = z.infer<typeof staffMemberSchema>
export type GrantRoleCommand = z.infer<typeof grantRoleCommandSchema>
export type RevokeRoleCommand = z.infer<typeof revokeRoleCommandSchema>
