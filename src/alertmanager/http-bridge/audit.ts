import { appendJsonLineDurable } from "./json-store.js";

/**
 * Every audit event is built from an explicit whitelist of fields below —
 * never from the raw webhook body, `labels`, `annotations`, or the bearer
 * token. `fingerprint` and `deliveryId` are retained because they are
 * themselves identifiers the rest of this codebase already treats as safe
 * to persist (see docs/alertmanager-ingestion.md): `fingerprint` is
 * Alertmanager's own label-set hash, not label content, and `deliveryId` is
 * a derived digest.
 */
export type AuditEvent =
  | {
      kind: "webhook_received";
      at: string;
      receiver: string;
      groupStatus: "firing" | "resolved";
      truncatedAlerts: number;
      acceptedCount: number;
      rejectedCount: number;
    }
  | {
      kind: "request_rejected";
      at: string;
      httpStatus: number;
      reason:
        | "missing_bearer_token"
        | "invalid_bearer_token"
        | "unsupported_content_type"
        | "body_too_large"
        | "invalid_json"
        | "invalid_envelope";
      envelopeReason?: string;
    }
  | {
      kind: "alert_canonicalization_rejected";
      at: string;
      index: number;
      reason: string;
    }
  | {
      kind: "alert_processed";
      at: string;
      fingerprint: string;
      deliveryId: string;
      alertStatus: "firing" | "resolved";
      startsAt: string;
      endsAt: string | null;
      disposition: string;
      occurrenceId?: string;
      reason?: string;
      replay: boolean;
    }
  | {
      kind: "persistence_failure";
      at: string;
      fingerprint: string;
      deliveryId: string;
      message: string;
    }
  | {
      kind: "fail_closed";
      at: string;
      fingerprint: string;
      deliveryId: string;
      errorType: "consistency" | "checkpoint_conflict";
      message: string;
    };

export class AuditLog {
  constructor(private readonly path: string) {}

  record(event: AuditEvent): void {
    appendJsonLineDurable(this.path, event);
  }
}
