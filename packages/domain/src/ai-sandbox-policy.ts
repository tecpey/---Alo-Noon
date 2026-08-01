import { DomainError } from './errors'

export interface AiSandboxPatchValidationRequest {
  readonly validationId: string
  readonly proposalId: string
  readonly tenantId: string
  readonly policyVersion: string
  readonly sandboxProfileVersion: string
  readonly baseCommitSha: string
  readonly patchArtifactUri: string
  readonly patchDigest: string
  readonly requestedAt: Date
}

export interface AiSandboxCheckAttestation {
  readonly check: string
  readonly outcome: 'PASS' | 'FAIL'
  readonly evidenceDigest: string
}

export interface AiSandboxPatchValidationTrustContext {
  readonly evaluatedAt: Date
  readonly attestation: {
    readonly validationId: string
    readonly proposalId: string
    readonly tenantId: string
    readonly policyVersion: string
    readonly sandboxProfileVersion: string
    readonly baseCommitSha: string
    readonly patchDigest: string
    readonly changedPaths: ReadonlyArray<string>
    readonly attestationDigest: string
    readonly completedAt: Date
    readonly networkAccess: false
    readonly secretMounts: false
    readonly productionCredentials: false
    readonly productionWriteAccess: false
    readonly checks: ReadonlyArray<AiSandboxCheckAttestation>
  }
  readonly policy: {
    readonly requiredChecks: ReadonlyArray<string>
    readonly allowedPathPrefixes: ReadonlyArray<string>
    readonly deniedPathPrefixes: ReadonlyArray<string>
    readonly maxAttestationAgeMs: number
  }
}

export interface AiSandboxPatchValidationDecision {
  readonly outcome: 'VALIDATED_PATCH_PROPOSAL'
  readonly validationId: string
  readonly policyVersion: string
  readonly attestationDigest: string
  readonly executionAuthorized: false
  readonly deploymentAuthorized: false
}

const digest = /^sha256:[a-f0-9]{64}$/
const gitSha = /^[a-f0-9]{40}$/

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function pathWithin(path: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/$/, '')
  return path === normalized || path.startsWith(`${normalized}/`)
}

function deny(reasons: ReadonlyArray<string>): never {
  throw new DomainError('AI_SANDBOX_VALIDATION_DENIED', 'AI sandbox validation denied', {
    reasons,
  })
}

export function evaluateAiSandboxPatchValidation(
  request: Readonly<AiSandboxPatchValidationRequest>,
  trust: Readonly<AiSandboxPatchValidationTrustContext>,
): Readonly<AiSandboxPatchValidationDecision> {
  const reasons: string[] = []
  const attestation = trust.attestation

  const requestTimeValid = isValidDate(request.requestedAt)
  const evaluationTimeValid = isValidDate(trust.evaluatedAt)
  const completionTimeValid = isValidDate(attestation.completedAt)
  if (!requestTimeValid || !evaluationTimeValid) {
    reasons.push('Request and trusted evaluation timestamps must be valid')
  } else if (request.requestedAt.getTime() > trust.evaluatedAt.getTime()) {
    reasons.push('Request timestamp cannot be later than trusted evaluation time')
  }
  if (!completionTimeValid) {
    reasons.push('Runner completion timestamp must be valid')
  } else if (
    requestTimeValid &&
    attestation.completedAt.getTime() < request.requestedAt.getTime()
  ) {
    reasons.push('Runner completion cannot precede the validation request')
  } else if (
    evaluationTimeValid &&
    attestation.completedAt.getTime() > trust.evaluatedAt.getTime()
  ) {
    reasons.push('Runner completion cannot be later than trusted evaluation time')
  } else if (
    evaluationTimeValid &&
    (!Number.isSafeInteger(trust.policy.maxAttestationAgeMs) ||
      trust.policy.maxAttestationAgeMs <= 0 ||
      trust.evaluatedAt.getTime() - attestation.completedAt.getTime() >
        trust.policy.maxAttestationAgeMs)
  ) {
    reasons.push('Trusted runner attestation is stale or has an invalid freshness policy')
  }

  const identityMatches =
    attestation.validationId === request.validationId &&
    attestation.proposalId === request.proposalId &&
    attestation.tenantId === request.tenantId
  if (!identityMatches) reasons.push('Trusted attestation scope does not match the request')
  if (
    attestation.policyVersion !== request.policyVersion ||
    attestation.sandboxProfileVersion !== request.sandboxProfileVersion
  ) {
    reasons.push('Trusted policy or sandbox profile version does not match')
  }
  if (
    !gitSha.test(request.baseCommitSha) ||
    attestation.baseCommitSha !== request.baseCommitSha ||
    !digest.test(request.patchDigest) ||
    attestation.patchDigest !== request.patchDigest ||
    !digest.test(attestation.attestationDigest)
  ) {
    reasons.push('Base commit, patch digest, or attestation digest is unverified')
  }

  if (
    attestation.networkAccess !== false ||
    attestation.secretMounts !== false ||
    attestation.productionCredentials !== false ||
    attestation.productionWriteAccess !== false
  ) {
    reasons.push('Sandbox must have no network, secrets, production credentials, or writes')
  }

  if (attestation.changedPaths.length === 0)
    reasons.push('Attested patch must change at least one path')
  for (const path of attestation.changedPaths) {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      reasons.push('Absolute paths and traversal are forbidden')
      continue
    }
    if (!trust.policy.allowedPathPrefixes.some((prefix) => pathWithin(path, prefix))) {
      reasons.push('Attested changed path is outside the authoritative allow-list')
    }
    if (trust.policy.deniedPathPrefixes.some((prefix) => pathWithin(path, prefix))) {
      reasons.push('Attested changed path is denied by authoritative policy')
    }
  }

  const checks = new Map(attestation.checks.map((check) => [check.check, check]))
  for (const required of trust.policy.requiredChecks) {
    const check = checks.get(required)
    if (!check || check.outcome !== 'PASS' || !digest.test(check.evidenceDigest)) {
      reasons.push(`Required trusted check did not pass: ${required}`)
    }
  }
  if (attestation.checks.some((check) => check.outcome === 'FAIL')) {
    reasons.push('Trusted runner reported a failed check')
  }

  if (reasons.length > 0) deny(reasons)

  return Object.freeze({
    outcome: 'VALIDATED_PATCH_PROPOSAL',
    validationId: request.validationId,
    policyVersion: request.policyVersion,
    attestationDigest: attestation.attestationDigest,
    executionAuthorized: false,
    deploymentAuthorized: false,
  })
}
