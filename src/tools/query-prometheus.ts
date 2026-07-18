import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

type PrometheusFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PrometheusToolConfig = {
  baseUrl: string;
  timeoutMs: number;
};

export type PrometheusInstantResult = {
  query: string;
  currentValue: number;
  observedAt: string;
  labels: Record<string, string>;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolvePrometheusToolConfig(
  rawConfig: unknown,
): PrometheusToolConfig {
  const config = readRecord(rawConfig);
  const baseUrl =
    typeof config?.prometheusBaseUrl === "string"
      ? config.prometheusBaseUrl.trim()
      : "";
  const timeoutMs =
    typeof config?.prometheusTimeoutMs === "number" &&
    Number.isInteger(config.prometheusTimeoutMs) &&
    config.prometheusTimeoutMs >= 200 &&
    config.prometheusTimeoutMs <= 30_000
      ? config.prometheusTimeoutMs
      : 5_000;

  if (!baseUrl) {
    throw new Error(
      "plugins.entries.dataops-guardian.config.prometheusBaseUrl is required",
    );
  }

  const parsed = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("Prometheus base URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "Prometheus credentials must not be embedded in prometheusBaseUrl",
    );
  }

  return {
    baseUrl: parsed.toString(),
    timeoutMs,
  };
}

function buildInstantQueryUrl(
  config: PrometheusToolConfig,
  query: string,
  time?: string,
): URL {
  const base = new URL(
    config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`,
  );
  const url = new URL("api/v1/query", base);
  url.searchParams.set("query", query);
  if (time) {
    url.searchParams.set("time", time);
  }
  return url;
}

function parsePrometheusVector(
  payload: unknown,
  query: string,
): PrometheusInstantResult {
  const envelope = readRecord(payload);
  const data = readRecord(envelope?.data);
  const result = Array.isArray(data?.result) ? data.result : undefined;

  if (envelope?.status !== "success") {
    throw new Error("Prometheus returned a non-success response");
  }
  if (data?.resultType !== "vector" || !result) {
    throw new Error("Prometheus query must return an instant vector");
  }
  if (result.length !== 1) {
    throw new Error(
      `Prometheus query must return exactly one series; received ${result.length}`,
    );
  }

  const sample = readRecord(result[0]);
  const value = Array.isArray(sample?.value) ? sample.value : undefined;
  const timestamp = typeof value?.[0] === "number" ? value[0] : Number(value?.[0]);
  const currentValue = Number(value?.[1]);
  const rawLabels = readRecord(sample?.metric) ?? {};
  const labels = Object.fromEntries(
    Object.entries(rawLabels)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  if (!Number.isFinite(timestamp) || !Number.isFinite(currentValue)) {
    throw new Error("Prometheus returned a non-finite sample");
  }

  return {
    query,
    currentValue,
    observedAt: new Date(timestamp * 1_000).toISOString(),
    labels,
  };
}

export async function queryPrometheusInstant(
  config: PrometheusToolConfig,
  params: { query: string; time?: string },
  fetchImpl: PrometheusFetch = fetch,
): Promise<PrometheusInstantResult> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("PromQL query is required");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(
      buildInstantQueryUrl(config, query, params.time),
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Prometheus HTTP request failed with ${response.status}`);
    }

    return parsePrometheusVector(await response.json(), query);
  } finally {
    clearTimeout(timer);
  }
}

export function createQueryPrometheusTool(
  rawConfig: unknown,
  fetchImpl: PrometheusFetch = fetch,
): AnyAgentTool {
  return {
    name: "guardian_query_prometheus",
    label: "Query Prometheus",
    description:
      "Run a read-only Prometheus instant query against the administrator-configured endpoint. The query must return exactly one series.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 2_048 }),
        time: Type.Optional(
          Type.String({
            description: "Optional RFC3339 evaluation time.",
            maxLength: 64,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { query: string; time?: string };
      return jsonResult(
        await queryPrometheusInstant(
          resolvePrometheusToolConfig(rawConfig),
          params,
          fetchImpl,
        ),
      );
    },
  };
}
