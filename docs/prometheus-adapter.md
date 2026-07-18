# Prometheus adapter contract

Status: **passed** locally on 2026-07-18 with `openclaw@2026.6.9`.

`guardian_query_prometheus` is a small, read-only adapter over Prometheus's
instant-query HTTP endpoint. It turns one PromQL result into the normalized
metric input used by the incident Reducer:

```json
{
  "query": "payment_success_rate{service=\"payments\",environment=\"proof\"}",
  "currentValue": 0.7,
  "observedAt": "2026-07-18T06:24:14.093Z",
  "labels": {
    "__name__": "payment_success_rate",
    "environment": "proof",
    "service": "payments"
  }
}
```

## Configuration

The Gateway administrator configures the endpoint and timeout:

```bash
openclaw config set \
  plugins.entries.dataops-guardian.config.prometheusBaseUrl \
  http://127.0.0.1:9090
openclaw config set \
  plugins.entries.dataops-guardian.config.prometheusTimeoutMs 5000
```

The Tool caller can provide `query` and an optional RFC3339 evaluation `time`.
It cannot choose or override the network endpoint.

## Fail-closed behavior

The adapter rejects:

- missing endpoints or protocols other than HTTP(S);
- credentials embedded in the endpoint URL;
- non-success HTTP or Prometheus responses;
- range, scalar, string, empty, or multi-series results;
- non-finite timestamps or sample values.

Requiring exactly one series prevents the orchestration layer from silently
selecting an arbitrary service, shard, or environment when PromQL is too broad.
The default timeout is five seconds and the accepted configured range is 200 ms
through 30 seconds.

This first slice deliberately does not implement bearer-token, mTLS, or managed
Prometheus authentication. Those belong in a later credential-provider
integration; secrets must not be placed in `prometheusBaseUrl` or Tool input.

## Reproducible proof

`npm run slice:proof` starts `scripts/mock-prometheus-server.mjs` on loopback,
configures the isolated OpenClaw profile to use it, and shuts it down on exit.
The proof checks the same Tool and HTTP response path that a real endpoint uses,
without making a production network request.
