export const DEFAULT_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1_000;
export const DEFAULT_EVIDENCE_MIN_COUNT = 1;
export const REQUIRED_EVIDENCE_SOURCE_PREFIXES = ["prometheus:"] as const;

export type EvidencePolicy = {
  minCount: number;
  maxAgeMs: number;
  maxFutureSkewMs: number;
  requiredSourcePrefixes: readonly string[];
};

export type EvidencePolicyResult = {
  ok: boolean;
  checkedAt: string;
  issues: string[];
};

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = {
  minCount: DEFAULT_EVIDENCE_MIN_COUNT,
  maxAgeMs: DEFAULT_EVIDENCE_MAX_AGE_MS,
  maxFutureSkewMs: 30_000,
  requiredSourcePrefixes: REQUIRED_EVIDENCE_SOURCE_PREFIXES,
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readEvidence(value: unknown): Array<{
  source: string;
  observedAt: string;
}> {
  const state = readRecord(value);
  if (!Array.isArray(state?.evidence)) {
    return [];
  }

  return state.evidence.flatMap((entry) => {
    const record = readRecord(entry);
    return typeof record?.source === "string" &&
      typeof record.observedAt === "string"
      ? [{ source: record.source, observedAt: record.observedAt }]
      : [];
  });
}

export function evaluateIncidentEvidence(
  state: unknown,
  checkedAt: string,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): EvidencePolicyResult {
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    throw new Error("evidence policy checkedAt must be a valid timestamp");
  }

  const evidence = readEvidence(state);
  const issues: string[] = [];

  if (evidence.length < policy.minCount) {
    issues.push(
      `at least ${policy.minCount} evidence item is required; received ${evidence.length}`,
    );
  }

  for (const prefix of policy.requiredSourcePrefixes) {
    const matching = evidence.filter((entry) => entry.source.startsWith(prefix));
    if (matching.length === 0) {
      issues.push(`required evidence source is missing: ${prefix}`);
      continue;
    }

    const hasFreshEvidence = matching.some((entry) => {
      const observedAtMs = Date.parse(entry.observedAt);
      if (!Number.isFinite(observedAtMs)) {
        return false;
      }
      const ageMs = checkedAtMs - observedAtMs;
      return ageMs <= policy.maxAgeMs && ageMs >= -policy.maxFutureSkewMs;
    });
    if (!hasFreshEvidence) {
      issues.push(`required evidence source is stale or invalid: ${prefix}`);
    }
  }

  return {
    ok: issues.length === 0,
    checkedAt,
    issues,
  };
}
