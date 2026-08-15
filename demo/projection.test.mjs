import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildDemoProjection, loadDemoProjection } from "./projection.mjs";

const artifactUrl = new URL(
  "./artifacts/validated-final-proof.json",
  import.meta.url,
);
const provenanceUrl = new URL("./artifacts/provenance.json", import.meta.url);

describe("proof replay projection", () => {
  it("loads the exact hash-bound CI artifact into a stable display model", async () => {
    const [model, artifactBytes, provenanceText] = await Promise.all([
      loadDemoProjection(),
      readFile(artifactUrl),
      readFile(provenanceUrl, "utf8"),
    ]);
    const provenance = JSON.parse(provenanceText);

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      provenance.validatedReportSha256,
    );
    expect(model).toMatchObject({
      mode: "sanitized-proof-replay",
      banner: "Demo mode — sanitized proof replay",
      provenance: {
        classification: "sanitized_ci_kind_proof",
        workflowRunNumber: 50,
        sourceCommit: "f480dcf99ee9dedcaa61ecf9e21332c8260377db",
      },
      incident: {
        identifier: "Withheld by the validated artifact contract",
        status: "Recovered",
        deduplication: "created → duplicate",
        mutationDispatches: 1,
      },
    });
    expect(model.events.map((event) => event.id)).toEqual([
      "alert-ingress",
      "deduplication",
      "prometheus-evidence",
      "evidence-gate",
      "human-approval",
      "allowlist-boundary",
      "rollback",
      "deployment-ready",
      "fresh-signal",
      "recovered",
    ]);
  });

  it("projects direct source slices without inventing identities or timestamps", async () => {
    const model = await loadDemoProjection();
    const byId = Object.fromEntries(
      model.events.map((event) => [event.id, event]),
    );

    expect(byId.deduplication.sourceJson).toEqual({
      replayDisposition: "duplicate",
    });
    expect(byId.rollback.sourceJson).toEqual({
      rollbackDecision: "rolled_back",
      dispatchCount: 1,
      generationChanged: true,
      immediateReplayDecision: "duplicate",
      postRestartReplayDecision: "duplicate",
    });
    expect(byId["fresh-signal"]).toMatchObject({
      evidenceClass: "artifact_field_plus_proof_contract",
      sourceJson: {
        prometheusHealthy: true,
        recoveredMetricValue: 1,
        threshold: 0.95,
        finalDecision: "recovered",
      },
    });
    for (const event of model.events) {
      expect(event).not.toHaveProperty("at");
      expect(event).not.toHaveProperty("timestamp");
      expect(event).not.toHaveProperty("incidentId");
      expect(event).not.toHaveProperty("target");
      expect(event.jsonPointers.length).toBeGreaterThan(0);
    }
  });

  it("exposes fail-closed observations that came from the live proof", async () => {
    const model = await loadDemoProjection();

    expect(model.failClosedScenarios).toMatchObject([
      {
        id: "approval-denied",
        outcome: "blocked",
        sourceJson: {
          deniedBlockedBy: "approval_gate",
          deniedMutationDispatchCount: 0,
        },
      },
      {
        id: "off-target",
        outcome: "allowlist_gate",
        sourceJson: { offTargetBlocked: true },
      },
      {
        id: "unhealthy-recovery",
        outcome: "not_recovered",
        sourceJson: { scaleToZeroIncidentCompleted: false },
      },
    ]);
  });

  it("keeps the exact sanitized report available and contains no common secret material", async () => {
    const [model, artifactText] = await Promise.all([
      loadDemoProjection(),
      readFile(artifactUrl, "utf8"),
    ]);

    expect(model.audit.sourceJson).toEqual(JSON.parse(artifactText));
    const forbiddenKey =
      /^(?:token|secret|password|credential|credentials|apiKey|accessKey|privateKey|authorizationHeader)$/i;
    const visit = (value) => {
      if (typeof value === "string") {
        expect(value).not.toMatch(/Bearer\s+[A-Za-z0-9]|gh[pousr]_|sk-[A-Za-z0-9]{10,}/);
        expect(value).not.toMatch(
          /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|workspace)\/)/,
        );
      } else if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          expect(key).not.toMatch(forbiddenKey);
          visit(child);
        }
      }
    };
    visit(model);
  });

  it("rejects provenance that is not bound to the report commit", async () => {
    const [reportText, provenanceText] = await Promise.all([
      readFile(artifactUrl, "utf8"),
      readFile(provenanceUrl, "utf8"),
    ]);
    const report = JSON.parse(reportText);
    const provenance = {
      ...JSON.parse(provenanceText),
      sourceCommit: "0000000000000000000000000000000000000000",
    };

    expect(() => buildDemoProjection(report, provenance)).toThrow(
      "provenance and report source commits differ",
    );
  });

  it("stays outside the core TypeScript build and runtime entrypoint", async () => {
    const [packageText, tsconfigText, adapterText] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
      readFile(new URL("./projection.mjs", import.meta.url), "utf8"),
    ]);
    const packageJson = JSON.parse(packageText);
    const tsconfig = JSON.parse(tsconfigText);

    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json");
    expect(packageJson.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);
    expect(adapterText).not.toMatch(/from\s+["']\.\.\/src\//);
  });
});
