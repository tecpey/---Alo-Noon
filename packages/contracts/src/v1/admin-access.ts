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
    }),
  ),
  /** Union of every permission the account's live grants carry. */
  permissions: z.array(z.string().min(1).max(100)),
  /** True for the account making the request, which may not revoke itself. */
  isSelf: z.boolean(),
})

export const grantRoleCommandSchema = z
  .object({
    mobileE164: mobileE164Schema,
    roleCode: roleCodeSchema,
    reason: reasonSchema,
  })
  .strict()

export const revokeRoleCommandSchema = z
  .object({
    grantId: uuidSchema,
    reason: reasonSchema,
  })
  .strict()

export type AdminRoleSummary = z.infer<typeof adminRoleSummarySchema>
export type StaffMember = z.infer<typeof staffMemberSchema>
export type GrantRoleCommand = z.infer<typeof grantRoleCommandSchema>
export type RevokeRoleCommand = z.infer<typeof revokeRoleCommandSchema>
