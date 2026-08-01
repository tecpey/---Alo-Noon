import { DomainError } from './errors'

export const AiAction = {
  DETECT: 'DETECT',
  CORRELATE: 'CORRELATE',
  EXPLAIN: 'EXPLAIN',
  PRIORITIZE: 'PRIORITIZE',
  DRAFT_INCIDENT: 'DRAFT_INCIDENT',
  PROPOSE_PATCH: 'PROPOSE_PATCH',
  OPEN_DRAFT_WORK_ITEM: 'OPEN_DRAFT_WORK_ITEM',
  PRODUCTION_WRITE: 'PRODUCTION_WRITE',
  DEPLOY: 'DEPLOY',
  READ_SECRET: 'READ_SECRET',
  CHANGE_PERMISSION: 'CHANGE_PERMISSION',
  FINANCIAL_ACTION: 'FINANCIAL_ACTION',
  CONTACT_CUSTOMER: 'CONTACT_CUSTOMER',
  CROSS_TENANT_ACCESS: 'CROSS_TENANT_ACCESS',
} as const
export type AiAction = (typeof AiAction)[keyof typeof AiAction]

const privilegedActions = new Set<AiAction>([
  AiAction.PRODUCTION_WRITE,
  AiAction.DEPLOY,
  AiAction.READ_SECRET,
  AiAction.CHANGE_PERMISSION,
  AiAction.FINANCIAL_ACTION,
  AiAction.CONTACT_CUSTOMER,
  AiAction.CROSS_TENANT_ACCESS,
])

export interface AiEvidenceReference {
  evidenceId: string
  tenantId: string
  classification: 'PUBLIC' | 'INTERNAL' | 'TENANT_CONFIDENTIAL' | 'PII'
  redactionStatus: 'NOT_REQUIRED' | 'REDACTED' | 'BLOCKED'
  provenanceUri: string
  contentDigest: string
  retainedUntil: Date
}

export interface AiHumanApproval {
  proposalId: string
  tenantId: string
  action: AiAction
  approvedByAccountId: string
  approvedAt: Date
  expiresAt: Date
  reason: string
  ticketReference: string
}

export interface AiProposalAdmissionRequest {
  proposalId: string
  tenantId: string
  agentCharterVersion: string
  modelVersion: string
  allowedActions: ReadonlyArray<AiAction>
  action: AiAction
  policyVersion: string
  promptInjectionAssessment: 'PASS' | 'FAIL' | 'NOT_EVALUATED'
  evidence: ReadonlyArray<AiEvidenceReference>
  approval?: AiHumanApproval
  requestedAt: Date
}

export interface AiProposalAdmissionDecision {
  outcome: 'ADMIT_ADVISORY_PROPOSAL' | 'ADMIT_APPROVED_PROPOSAL'
  policyVersion: string
  executionAuthorized: false
}

function deny(reasons: ReadonlyArray<string>): never {
  throw new DomainError('AI_POLICY_DENIED', 'AI proposal admission denied', { reasons })
}

export function evaluateAiProposalAdmission(
  request: AiProposalAdmissionRequest,
): Readonly<AiProposalAdmissionDecision> {
  const reasons: string[] = []

  if (!request.tenantId) reasons.push('Tenant context is required')
  if (!request.proposalId) reasons.push('Proposal ID is required')
  if (!request.agentCharterVersion) reasons.push('Versioned agent charter is required')
  if (!request.modelVersion) reasons.push('Model version is required')
  if (!request.policyVersion) reasons.push('Policy version is required')
  if (!request.allowedActions.includes(request.action)) {
    reasons.push('Action is outside the agent allow-list')
  }
  if (request.promptInjectionAssessment !== 'PASS') {
    reasons.push('Prompt-injection assessment must pass')
  }
  if (request.evidence.length === 0) reasons.push('At least one evidence reference is required')

  for (const evidence of request.evidence) {
    if (evidence.tenantId !== request.tenantId) {
      reasons.push('Cross-tenant evidence is forbidden')
    }
    if (!evidence.provenanceUri || !/^sha256:[a-f0-9]{64}$/.test(evidence.contentDigest)) {
      reasons.push('Evidence provenance and digest are required')
    }
    if (evidence.redactionStatus === 'BLOCKED') {
      reasons.push('Blocked evidence cannot enter the AI control plane')
    }
    if (evidence.classification === 'PII' && evidence.redactionStatus !== 'REDACTED') {
      reasons.push('PII evidence must be redacted')
    }
    if (evidence.retainedUntil.getTime() <= request.requestedAt.getTime()) {
      reasons.push('Expired evidence cannot be used')
    }
  }

  if (reasons.length > 0) deny(reasons)

  if (!privilegedActions.has(request.action)) {
    return Object.freeze({
      outcome: 'ADMIT_ADVISORY_PROPOSAL',
      policyVersion: request.policyVersion,
      executionAuthorized: false,
    })
  }

  const approval = request.approval
  if (!approval) deny(['Privileged proposals require explicit human approval'])

  if (
    approval.proposalId !== request.proposalId ||
    approval.tenantId !== request.tenantId ||
    approval.action !== request.action
  ) {
    deny(['Approval scope does not match the proposal'])
  }
  if (!approval.approvedByAccountId || !approval.reason || !approval.ticketReference) {
    deny(['Human approver, reason, and ticket reference are required'])
  }
  if (
    approval.approvedAt.getTime() > request.requestedAt.getTime() ||
    approval.expiresAt.getTime() <= request.requestedAt.getTime()
  ) {
    deny(['Approval is not active at proposal admission time'])
  }

  return Object.freeze({
    outcome: 'ADMIT_APPROVED_PROPOSAL',
    policyVersion: request.policyVersion,
    executionAuthorized: false,
  })
}
