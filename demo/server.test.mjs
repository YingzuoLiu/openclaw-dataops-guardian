import { afterEach, describe, expect, it } from "vitest";

import { startDemoServer } from "./server.mjs";

const openServers = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function start() {
  const running = await startDemoServer({ port: 0 });
  openServers.push(running.server);
  return running;
}

describe("proof replay server", () => {
  it("starts on loopback and serves the offline projection", async () => {
    const running = await start();
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const [health, projection] = await Promise.all([
      fetch(`${running.url}/healthz`),
      fetch(`${running.url}/api/demo`),
    ]);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      mode: "sanitized-proof-replay",
    });
    expect(projection.status).toBe(200);
    expect(projection.headers.get("cache-control")).toBe("no-store");
    expect(await projection.json()).toMatchObject({
      banner: "Demo mode — sanitized proof replay",
      incident: { status: "Recovered" },
    });
  });

  it("serves only an explicit static allowlist with restrictive headers", async () => {
    const running = await start();
    const [page, app, css, traversal] = await Promise.all([
      fetch(`${running.url}/`),
      fetch(`${running.url}/app.js`),
      fetch(`${running.url}/styles.css`),
      fetch(`${running.url}/package.json`),
    ]);

    expect(page.status).toBe(200);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    const html = await page.text();
    expect(html).toContain("Demo mode — sanitized proof replay");
    expect(html).toContain("Reset demo");
    expect(html).toContain("Audit / proof JSON");
    expect(html).not.toMatch(/<script[^>]+https?:|<link[^>]+https?:/i);
    expect(app.headers.get("content-type")).toContain("text/javascript");
    const appSource = await app.text();
    expect(appSource).toContain('fetch("/api/demo"');
    expect(appSource).not.toMatch(/fetch\(["']https?:/i);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(traversal.status).toBe(404);
  });

  it("supports repeated page loads and reset assets without server mutation", async () => {
    const running = await start();
    const first = await fetch(`${running.url}/api/demo`).then((response) =>
      response.text(),
    );
    const second = await fetch(`${running.url}/api/demo`).then((response) =>
      response.text(),
    );

    expect(second).toBe(first);
    expect(running.projection.incident.mutationDispatches).toBe(1);
  });

  it("falls back to another loopback port when the default choice is busy", async () => {
    const first = await start();
    const firstAddress = first.server.address();
    expect(firstAddress).not.toBeNull();
    expect(typeof firstAddress).not.toBe("string");

    const second = await startDemoServer({ port: firstAddress.port });
    openServers.push(second.server);

    expect(second.url).not.toBe(first.url);
    expect(await fetch(`${second.url}/healthz`).then((response) => response.status)).toBe(
      200,
    );
  });
});
