const ORGANIZATION_AUTH_REJECTION = /organization\s+(?:role|policy)\s+sync\s+failed\s+with\s+HTTP\s+(?:401|403)\b/iu;

export function isOrganizationAuthorizationRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return ORGANIZATION_AUTH_REJECTION.test(message);
}

export function organizationAuthorizationRecoveryMessage(): string {
  return "company access expired or was revoked; re-enroll this organization connection in AI & Models before retrying";
}
