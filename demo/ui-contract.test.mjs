import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readDemoFile = (path) =>
  readFile(new URL(path, import.meta.url), "utf8");

describe("Proof Replay Console UI contract", () => {
  it("puts resolved safety outcomes ahead of replay without overstating proof", async () => {
    const [html, app] = await Promise.all([
      readDemoFile("./public/index.html"),
      readDemoFile("./public/app.js"),
    ]);

    expect(html).toContain("Demo mode — sanitized proof replay");
    expect(html).toContain("PRE-MUTATION SAFETY GATES");
    expect(html).toContain("FAIL-CLOSED CASES FROM THE SAME RUN");
    expect(html).not.toContain("NON-BYPASSABLE CONTROLS");
    expect(html).not.toContain("LIVE NEGATIVE PROOFS");
    expect(html).not.toMatch(/id="gate-grid"[^>]*aria-live/);
    expect(app).toContain('className = `gate-card is-revealed');
    expect(app).toContain('className = `recovery-card is-revealed');
    expect(app).not.toContain('"pending"');
    expect(app).not.toContain('"waiting"');
  });

  it("keeps static product copy in HTML and artifact facts in the projection", async () => {
    const [html, app, projection] = await Promise.all([
      readDemoFile("./public/index.html"),
      readDemoFile("./public/app.js"),
      readDemoFile("./projection.mjs"),
    ]);

    expect(html).toContain("Guardian persists one incident");
    expect(html).toContain(
      "Fast visual replay only. No live Kubernetes operation is performed.",
    );
    expect(html).not.toContain('id="value-statement"');
    expect(html).not.toContain('id="replay-notice"');
    expect(app).not.toContain("model.valueStatement");
    expect(app).not.toContain("model.replayNotice");
    expect(projection).not.toContain("valueStatement:");
    expect(projection).not.toContain("replayNotice:");
  });

  it("updates timeline nodes in place and provides a next-section cue", async () => {
    const [html, app] = await Promise.all([
      readDemoFile("./public/index.html"),
      readDemoFile("./public/app.js"),
    ]);

    expect(app).toContain('timeline.dataset.initialized = "true"');
    expect(app).not.toContain('byId("timeline").replaceChildren');
    expect(app).toContain("timeline.scrollTo({");
    expect(html).toContain('id="replay-next-link"');
    expect(app).toContain('byId("replay-next-link").hidden = !snapshot.complete');
    expect(html).toContain('id="play-button-label"');
    expect(app).not.toContain("playButton.lastChild");
  });

  it("honors reduced motion and keeps shared-screen text readable", async () => {
    const [app, css] = await Promise.all([
      readDemoFile("./public/app.js"),
      readDemoFile("./public/styles.css"),
    ]);
    const textCss = css.replace(/\.mode-badge span\s*{[^}]*}/, "");

    expect(app).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(app).toContain("controller.finish()");
    expect(textCss).not.toMatch(/font-size:\s*(?:[0-9]|10)px/);
    expect(css).toContain(".audit-details[open] .expand-hint .when-open");
    expect(css).toMatch(/\.source-pointers > summary,[\s\S]*?min-height: 44px;/);
    expect(css).toMatch(/\.json-panel button,[\s\S]*?min-height: 36px;/);
  });
});
