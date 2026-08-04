import { DomainError } from './errors'

export type CommunicationChannel = 'SMS' | 'EMAIL'
export type CommunicationScope = 'PLATFORM' | 'TENANT'
export type CommunicationLocale = 'fa-IR' | 'en-US'
export type MessageTemplateStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ACTIVE' | 'ARCHIVED'
export type MessageTemplatePurpose =
  | 'AUTH_OTP'
  | 'SECURITY_ALERT'
  | 'ORDER_STATUS'
  | 'PAYMENT_STATUS'
  | 'COURIER_STATUS'
  | 'BAKERY_OPERATIONS'
  | 'SUPPORT'
  | 'SYSTEM'

export type TemplateVariableType = 'STRING' | 'INTEGER' | 'MONEY_IRR' | 'URL'

export interface TemplateVariableDefinition {
  readonly name: string
  readonly type: TemplateVariableType
  readonly required: boolean
  readonly maxLength?: number
}

export interface MessageTemplateVersion {
  readonly id: string
  readonly templateId: string
  readonly version: number
  readonly channel: CommunicationChannel
  readonly locale: CommunicationLocale
  readonly purpose: MessageTemplatePurpose
  readonly status: MessageTemplateStatus
  readonly subject: string | null
  readonly body: string
  readonly variables: readonly TemplateVariableDefinition[]
  readonly createdByActorId: string
  readonly reviewedByActorId: string | null
  readonly approvedAt: Date | null
}

export interface ProviderTemplateBinding {
  readonly id: string
  readonly templateVersionId: string
  readonly providerCode: string
  readonly providerTemplateReference: string
  readonly enabled: boolean
}

export interface CreateTemplateVersionInput {
  readonly id: string
  readonly templateId: string
  readonly version: number
  readonly channel: CommunicationChannel
  readonly locale: CommunicationLocale
  readonly purpose: MessageTemplatePurpose
  readonly subject?: string | null
  readonly body: string
  readonly variables: readonly TemplateVariableDefinition[]
  readonly createdByActorId: string
}

const variableNamePattern = /^[a-z][a-zA-Z0-9]{0,63}$/
const providerCodePattern = /^[A-Z][A-Z0-9_]{1,31}$/

export function createTemplateVersion(input: CreateTemplateVersionInput): MessageTemplateVersion {
  const body = input.body.trim()
  if (!body || body.length > 20_000) {
    throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'Template body is invalid')
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'Template version is invalid')
  }

  const subject = normalizeSubject(input.channel, input.subject)
  const variables = validateVariableSchema(input.variables)
  assertDeclaredVariablesOnly(body, variables)
  if (subject) assertDeclaredVariablesOnly(subject, variables)

  return Object.freeze({
    id: requiredIdentifier(input.id, 'Template version id'),
    templateId: requiredIdentifier(input.templateId, 'Template id'),
    version: input.version,
    channel: input.channel,
    locale: input.locale,
    purpose: input.purpose,
    status: 'DRAFT',
    subject,
    body,
    variables,
    createdByActorId: requiredIdentifier(input.createdByActorId, 'Creator actor id'),
    reviewedByActorId: null,
    approvedAt: null,
  })
}

export function submitTemplateForReview(
  version: MessageTemplateVersion,
): MessageTemplateVersion {
  assertStatus(version, 'DRAFT')
  return Object.freeze({ ...version, status: 'IN_REVIEW' })
}

export function approveTemplateVersion(
  version: MessageTemplateVersion,
  approverActorId: string,
  approvedAt: Date,
): MessageTemplateVersion {
  assertStatus(version, 'IN_REVIEW')
  const approver = requiredIdentifier(approverActorId, 'Approver actor id')
  if (approver === version.createdByActorId) {
    throw new DomainError(
      'COMMUNICATION_APPROVAL_SEGREGATION_REQUIRED',
      'Template creator cannot approve the same version',
    )
  }
  if (Number.isNaN(approvedAt.getTime())) {
    throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'Approval timestamp is invalid')
  }
  return Object.freeze({
    ...version,
    status: 'APPROVED',
    reviewedByActorId: approver,
    approvedAt: new Date(approvedAt),
  })
}

export function activateTemplateVersion(
  version: MessageTemplateVersion,
): MessageTemplateVersion {
  assertStatus(version, 'APPROVED')
  return Object.freeze({ ...version, status: 'ACTIVE' })
}

export function archiveTemplateVersion(
  version: MessageTemplateVersion,
): MessageTemplateVersion {
  if (version.status !== 'APPROVED' && version.status !== 'ACTIVE') {
    throw invalidTransition(version.status, 'ARCHIVED')
  }
  return Object.freeze({ ...version, status: 'ARCHIVED' })
}

export function createProviderTemplateBinding(
  input: ProviderTemplateBinding,
): ProviderTemplateBinding {
  if (!providerCodePattern.test(input.providerCode)) {
    throw new DomainError('COMMUNICATION_PROVIDER_BINDING_INVALID', 'Provider code is invalid')
  }
  const reference = input.providerTemplateReference.trim()
  if (!reference || reference.length > 200) {
    throw new DomainError(
      'COMMUNICATION_PROVIDER_BINDING_INVALID',
      'Provider template reference is invalid',
    )
  }
  return Object.freeze({
    id: requiredIdentifier(input.id, 'Provider binding id'),
    templateVersionId: requiredIdentifier(input.templateVersionId, 'Template version id'),
    providerCode: input.providerCode,
    providerTemplateReference: reference,
    enabled: input.enabled,
  })
}

export function renderTemplate(
  version: MessageTemplateVersion,
  values: Readonly<Record<string, unknown>>,
): { readonly subject: string | null; readonly body: string } {
  if (version.status !== 'APPROVED' && version.status !== 'ACTIVE') {
    throw new DomainError(
      'COMMUNICATION_TEMPLATE_NOT_RENDERABLE',
      'Only approved or active templates can be rendered',
    )
  }

  const schema = new Map(version.variables.map((variable) => [variable.name, variable]))
  for (const key of Object.keys(values)) {
    if (!schema.has(key)) {
      throw new DomainError(
        'COMMUNICATION_TEMPLATE_VARIABLE_INVALID',
        `Unknown template variable: ${key}`,
      )
    }
  }

  const normalized: Record<string, string> = {}
  for (const variable of version.variables) {
    const raw = values[variable.name]
    if (raw === undefined || raw === null) {
      if (variable.required) {
        throw new DomainError(
          'COMMUNICATION_TEMPLATE_VARIABLE_REQUIRED',
          `Required template variable is missing: ${variable.name}`,
        )
      }
      normalized[variable.name] = ''
      continue
    }
    normalized[variable.name] = normalizeVariableValue(variable, raw)
  }

  const replace = (input: string): string =>
    input.replace(/{{\s*([a-z][a-zA-Z0-9]{0,63})\s*}}/g, (_match, name: string) => {
      if (!(name in normalized)) {
        throw new DomainError(
          'COMMUNICATION_TEMPLATE_VARIABLE_REQUIRED',
          `Template variable is missing: ${name}`,
        )
      }
      return normalized[name]!
    })

  return Object.freeze({
    subject: version.subject ? replace(version.subject) : null,
    body: replace(version.body),
  })
}

function validateVariableSchema(
  variables: readonly TemplateVariableDefinition[],
): readonly TemplateVariableDefinition[] {
  if (variables.length > 50) {
    throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'Too many template variables')
  }
  const seen = new Set<string>()
  const validated = variables.map((variable) => {
    if (!variableNamePattern.test(variable.name) || seen.has(variable.name)) {
      throw new DomainError(
        'COMMUNICATION_TEMPLATE_INVALID',
        'Template variable names must be unique and valid',
      )
    }
    seen.add(variable.name)
    if (
      variable.maxLength !== undefined &&
      (!Number.isInteger(variable.maxLength) || variable.maxLength < 1 || variable.maxLength > 2_000)
    ) {
      throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'Variable max length is invalid')
    }
    return Object.freeze({ ...variable })
  })
  return Object.freeze(validated)
}

function assertDeclaredVariablesOnly(
  content: string,
  variables: readonly TemplateVariableDefinition[],
): void {
  const declared = new Set(variables.map((variable) => variable.name))
  for (const match of content.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
    const name = match[1]?.trim() ?? ''
    if (!variableNamePattern.test(name) || !declared.has(name)) {
      throw new DomainError(
        'COMMUNICATION_TEMPLATE_INVALID',
        `Template references an undeclared variable: ${name}`,
      )
    }
  }
}

function normalizeSubject(channel: CommunicationChannel, subject: string | null | undefined): string | null {
  if (channel === 'SMS') {
    if (subject !== undefined && subject !== null && subject.trim()) {
      throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'SMS templates cannot define a subject')
    }
    return null
  }
  const normalized = subject?.trim() ?? ''
  if (!normalized || normalized.length > 300) {
    throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', 'Email subject is invalid')
  }
  return normalized
}

function normalizeVariableValue(variable: TemplateVariableDefinition, raw: unknown): string {
  let value: string
  switch (variable.type) {
    case 'STRING':
      if (typeof raw !== 'string') throw invalidVariable(variable.name)
      value = raw
      break
    case 'INTEGER':
    case 'MONEY_IRR':
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) throw invalidVariable(variable.name)
      value = String(raw)
      break
    case 'URL':
      if (typeof raw !== 'string') throw invalidVariable(variable.name)
      try {
        const parsed = new URL(raw)
        if (parsed.protocol !== 'https:') throw invalidVariable(variable.name)
      } catch {
        throw invalidVariable(variable.name)
      }
      value = raw
      break
  }
  if (variable.maxLength !== undefined && value.length > variable.maxLength) {
    throw invalidVariable(variable.name)
  }
  return value
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200) {
    throw new DomainError('COMMUNICATION_TEMPLATE_INVALID', `${label} is invalid`)
  }
  return normalized
}

function assertStatus(version: MessageTemplateVersion, expected: MessageTemplateStatus): void {
  if (version.status !== expected) throw invalidTransition(version.status, expected)
}

function invalidTransition(from: MessageTemplateStatus, to: MessageTemplateStatus): DomainError {
  return new DomainError(
    'COMMUNICATION_TEMPLATE_TRANSITION_INVALID',
    `Template transition ${from} -> ${to} is not allowed`,
  )
}

function invalidVariable(name: string): DomainError {
  return new DomainError(
    'COMMUNICATION_TEMPLATE_VARIABLE_INVALID',
    `Template variable is invalid: ${name}`,
  )
}
