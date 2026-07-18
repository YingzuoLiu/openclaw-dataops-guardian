import { describe, expect, it } from "vitest";

import {
  queryPrometheusInstant,
  resolvePrometheusToolConfig,
} from "./query-prometheus.js";

const config = {
  baseUrl: "http://127.0.0.1:19090/",
  timeoutMs: 1_000,
};

describe("resolvePrometheusToolConfig", () => {
  it("accepts an administrator-configured HTTP endpoint", () => {
    expect(
      resolvePrometheusToolConfig({
        prometheusBaseUrl: "http://127.0.0.1:19090",
        prometheusTimeoutMs: 2_000,
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:19090/",
      timeoutMs: 2_000,
    });
  });

  it("rejects credentials embedded in the URL", () => {
    expect(() =>
      resolvePrometheusToolConfig({
        prometheusBaseUrl: "https://user:secret@prometheus.example.com",
      }),
    ).toThrow("must not be embedded");
  });
});

describe("queryPrometheusInstant", () => {
  it("returns one finite vector sample", async () => {
    const fetchImpl = async (input: string | URL) => {
      expect(String(input)).toContain(
        "query=payment_success_rate%7Bservice%3D%22payments%22%7D",
      );
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              {
                metric: { service: "payments", __name__: "payment_success_rate" },
                value: [Date.parse("2026-07-18T00:00:00.000Z") / 1_000, "0.7"],
              },
            ],
          },
        }),
        { status: 200 },
      );
    };

    await expect(
      queryPrometheusInstant(
        config,
        { query: 'payment_success_rate{service="payments"}' },
        fetchImpl,
      ),
    ).resolves.toEqual({
      query: 'payment_success_rate{service="payments"}',
      currentValue: 0.7,
      observedAt: "2026-07-18T00:00:00.000Z",
      labels: {
        __name__: "payment_success_rate",
        service: "payments",
      },
    });
  });

  it("rejects ambiguous multi-series results", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              { metric: { instance: "a" }, value: [1, "0.7"] },
              { metric: { instance: "b" }, value: [1, "0.8"] },
            ],
          },
        }),
        { status: 200 },
      );

    await expect(
      queryPrometheusInstant(config, { query: "up" }, fetchImpl),
    ).rejects.toThrow("exactly one series; received 2");
  });
});
