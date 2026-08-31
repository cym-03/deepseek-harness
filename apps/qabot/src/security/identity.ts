/** Portal-signed identity claims accepted by Qabot's versioned API. */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const QABOT_ROLES = [
  'Employee',
  'Agent',
  'DepartmentAdmin',
  'KnowledgeEditor',
  'KnowledgeReviewer',
  'SystemAdmin',
] as const

export type QabotRole = typeof QABOT_ROLES[number]

export interface PortalIdentity {
  subjectId: string
  employeeId: string
  displayName: string
  departmentIds: string[]
  roles: QabotRole[]
  issuedAt: number
  expiresAt: number
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function isIdentity(value: unknown): value is PortalIdentity {
  if (typeof value !== 'object' || value === null) return false
  const claim = value as Record<string, unknown>
  return typeof claim.subjectId === 'string' && claim.subjectId !== ''
    && typeof claim.employeeId === 'string' && claim.employeeId !== ''
    && typeof claim.displayName === 'string'
    && Array.isArray(claim.departmentIds) && claim.departmentIds.every(item => typeof item === 'string')
    && Array.isArray(claim.roles) && claim.roles.every(item => typeof item === 'string' && QABOT_ROLES.includes(item as QabotRole))
    && typeof claim.issuedAt === 'number' && Number.isFinite(claim.issuedAt)
    && typeof claim.expiresAt === 'number' && Number.isFinite(claim.expiresAt)
}

/** Verifies a compact `payload.signature` token signed with HMAC-SHA256. */
export function verifyPortalIdentity(token: string, secret: string, now = Date.now()): PortalIdentity {
  const [payloadPart, signaturePart, extra] = token.split('.')
  if (payloadPart === undefined || signaturePart === undefined || extra !== undefined) {
    throw new Error('IDENTITY_TOKEN_INVALID')
  }
  const expected = createHmac('sha256', secret).update(payloadPart).digest()
  const actual = decodeBase64Url(signaturePart)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('IDENTITY_TOKEN_INVALID')
  }
  let value: unknown
  try {
    value = JSON.parse(decodeBase64Url(payloadPart).toString('utf8'))
  } catch {
    throw new Error('IDENTITY_TOKEN_INVALID')
  }
  if (!isIdentity(value) || value.issuedAt > now || value.expiresAt <= now) {
    throw new Error('IDENTITY_TOKEN_INVALID')
  }
  return value
}

/** Creates a token for BFF integration and automated tests. */
export function signPortalIdentity(identity: PortalIdentity, secret: string): string {
  const payload = Buffer.from(JSON.stringify(identity)).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/** Returns whether an identity carries at least one accepted role. */
export function hasRole(identity: PortalIdentity, roles: readonly QabotRole[]): boolean {
  return roles.some(role => identity.roles.includes(role))
}
