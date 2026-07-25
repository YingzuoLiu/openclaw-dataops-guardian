import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_DEPLOYMENT,
  ALLOWED_NAMESPACE,
  SPIKE_ANNOTATION,
  patchAndRestoreDeployment,
  runKubernetesProbe,
} from "./spike.mjs";

function deployment({ annotation = "baseline", resourceVersion = "1" } = {}) {
  return {
    metadata: {
      name: ALLOWED_DEPLOYMENT,
      namespace: ALLOWED_NAMESPACE,
      uid: "day0-deployment-uid",
      resourceVersion,
      generation: 1,
      annotations: {
        [SPIKE_ANNOTATION]: annotation,
      },
    },
    status: {
      observedGeneration: 1,
      replicas: 1,
      availableReplicas: 1,
    },
  };
}

function fakeApi() {
  let current = deployment();
  const patches = [];

  return {
    patches,
    async readNamespacedDeployment() {
      return structuredClone(current);
    },
    async patchNamespacedDeployment({ body }) {
      const expectedResourceVersion = body[0].value;
      const expectedAnnotation = body[1].value;
      const nextAnnotation = body[2].value;
      assert.equal(current.metadata.resourceVersion, expectedResourceVersion);
      assert.equal(
        current.metadata.annotations[SPIKE_ANNOTATION],
        expectedAnnotation,
      );
      patches.push(structuredClone(body));
      current.metadata.annotations[SPIKE_ANNOTATION] = nextAnnotation;
      current.metadata.resourceVersion = String(
        Number(current.metadata.resourceVersion) + 1,
      );
      return structuredClone(current);
    },
  };
}

test("rejects a target outside the static allowlist before creating a client", async () => {
  let clientCreated = false;

  await assert.rejects(
    runKubernetesProbe({
      rawConfig: {},
      action: "read",
      namespace: "default",
      deployment: "payments-day0",
      clientFactory: async () => {
        clientCreated = true;
        throw new Error("must not be called");
      },
    }),
    /static allowlist/,
  );

  assert.equal(clientCreated, false);
});

test("summarizes the allowlisted Deployment read", async () => {
  const api = fakeApi();
  const result = await runKubernetesProbe({
    rawConfig: {},
    action: "read",
    namespace: ALLOWED_NAMESPACE,
    deployment: ALLOWED_DEPLOYMENT,
    clientFactory: async () => ({
      api,
      apiServer: "https://127.0.0.1:6443/",
    }),
  });

  assert.equal(result.execution.context, "openclaw_gateway_plugin");
  assert.equal(result.execution.kubeconfigReadable, true);
  assert.equal(result.deployment.uid, "day0-deployment-uid");
});

test("performs one controlled patch and restores the original value", async () => {
  const api = fakeApi();
  const result = await patchAndRestoreDeployment(api, "day0-test-marker");

  assert.equal(result.writeObserved, true);
  assert.equal(result.restored, true);
  assert.equal(api.patches.length, 2);
  assert.equal(api.patches[0][2].value, "day0-test-marker");
  assert.equal(api.patches[1][2].value, "baseline");
});
