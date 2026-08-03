import { createHash, timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

export function extractBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : undefined;
}

/**
 * Constant-time bearer token check. Both sides are hashed to a fixed-length
 * digest first so `timingSafeEqual` never sees operand-length differences —
 * an attacker who supplies a short or long guess cannot distinguish
 * "wrong length" from "wrong content" through timing, and a per-byte early
 * exit inside `timingSafeEqual` only ever compares fixed-size digests.
 */
export function isValidBearerToken(
  provided: string | undefined,
  expectedToken: string,
): boolean {
  if (provided === undefined) {
    return false;
  }
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256")
    .update(expectedToken, "utf8")
    .digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
