/**
 * Serializes async work per fingerprint within this single bridge process.
 * Two deliveries for the same fingerprint always run one after the other;
 * deliveries for different fingerprints run independently. This is
 * explicitly a single-instance guarantee — there is no cross-process lock,
 * by design (see the explicit exclusions in docs/alertmanager-http-bridge.md).
 */
export class FingerprintLock {
  private readonly tail = new Map<string, Promise<void>>();

  async run<T>(fingerprint: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tail.get(fingerprint) ?? Promise.resolve();
    const settled = previous.then(fn, fn);
    const marker: Promise<void> = settled.then(
      () => undefined,
      () => undefined,
    );
    this.tail.set(fingerprint, marker);
    void marker.finally(() => {
      if (this.tail.get(fingerprint) === marker) {
        this.tail.delete(fingerprint);
      }
    });
    return settled;
  }
}
