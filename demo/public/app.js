import { ReplayState } from "/replay-state.mjs";

function byId(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing demo element #${id}`);
  }
  return element;
}

function setText(id, value) {
  byId(id).textContent = String(value);
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function labelFromIdentifier(value) {
  return String(value)
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function copyText(button, value, successLabel) {
  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = successLabel;
  } catch {
    button.textContent = "Copy unavailable";
  }
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

function setTrustedGithubLink(id, value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`unexpected proof source link for #${id}`);
  }
  byId(id).href = url.href;
}

function renderStaticModel(model) {
  setText("value-statement", model.valueStatement);
  setText("replay-notice", model.replayNotice);
  setText("incident-title", model.incident.reference);
  setText("incident-identifier", model.incident.identifier);
  setText("dedup-result", model.incident.deduplication);
  setText("mutation-count", model.incident.mutationDispatches);
  setText("completion-rule", model.incident.recovery);
  setText("commit-link", model.provenance.shortCommit);
  setText(
    "audit-summary-meta",
    `run #${model.provenance.workflowRunNumber} · commit ${model.provenance.shortCommit} · sha256 ${model.provenance.reportSha256.slice(0, 12)}…`,
  );
  setText("audit-summary-title", model.audit.title);
  setText("audit-description", model.audit.description);
  setText("audit-json", prettyJson(model.audit.sourceJson));

  setTrustedGithubLink("commit-link", model.provenance.commitUrl);
  setTrustedGithubLink("workflow-link", model.provenance.workflowUrl);
  setTrustedGithubLink("docs-link", model.provenance.documentationUrl);
  setTrustedGithubLink("source-link", model.provenance.commitUrl);

  byId("header-docs-link").href = "#provenance";

  byId("copy-audit-json").addEventListener("click", (event) => {
    copyText(event.currentTarget, prettyJson(model.audit.sourceJson), "Copied");
  });
}

function renderFailClosed(model) {
  const grid = byId("fail-closed-grid");
  const cards = model.failClosedScenarios.map((scenario) => {
    const article = document.createElement("article");
    article.className = "fail-card";

    const top = document.createElement("div");
    top.className = "fail-card-top";
    const gate = document.createElement("span");
    gate.className = "fail-gate";
    gate.textContent = scenario.gate;
    const outcome = document.createElement("span");
    outcome.className = "fail-outcome";
    outcome.textContent = scenario.outcome;
    top.append(gate, outcome);

    const title = document.createElement("h3");
    title.textContent = scenario.title;
    const summary = document.createElement("p");
    summary.textContent = scenario.summary;

    const details = document.createElement("details");
    const detailsSummary = document.createElement("summary");
    detailsSummary.textContent = "Inspect sanitized fields";
    const pre = document.createElement("pre");
    pre.textContent = prettyJson(scenario.sourceJson);
    details.append(detailsSummary, pre);

    article.append(top, title, summary, details);
    return article;
  });
  grid.replaceChildren(...cards);
}

function eventIndex(model, eventId) {
  return model.events.findIndex((event) => event.id === eventId);
}

function renderGates(model, snapshot) {
  const cards = model.gates.map((gate, index) => {
    const revealIndex = eventIndex(model, gate.revealAt);
    const revealed = snapshot.cursor >= revealIndex;
    const article = document.createElement("article");
    article.className = `gate-card${revealed ? " is-revealed" : ""}`;

    const number = document.createElement("span");
    number.className = "gate-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const copy = document.createElement("div");
    copy.className = "gate-copy";
    const label = document.createElement("strong");
    label.textContent = gate.label;
    const detail = document.createElement("small");
    detail.textContent = gate.detail;
    copy.append(label, detail);

    const state = document.createElement("span");
    state.className = "gate-state";
    state.textContent = revealed ? gate.state : "pending";

    article.append(number, copy, state);
    return article;
  });
  byId("gate-grid").replaceChildren(...cards);
}

function renderRecovery(model, snapshot) {
  const icons = ["▣", "⌁"];
  const cards = model.recoveryChecks.map((check, index) => {
    const revealIndex = eventIndex(model, check.revealAt);
    const revealed = snapshot.cursor >= revealIndex;
    const article = document.createElement("article");
    article.className = `recovery-card${revealed ? " is-revealed" : ""}`;

    const icon = document.createElement("span");
    icon.className = "recovery-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = icons[index] ?? "✓";

    const copy = document.createElement("div");
    copy.className = "recovery-copy";
    const label = document.createElement("strong");
    label.textContent = check.label;
    const detail = document.createElement("small");
    detail.textContent = check.detail;
    copy.append(label, detail);

    const state = document.createElement("span");
    state.className = "recovery-state";
    state.textContent = revealed ? check.state : "waiting";

    article.append(icon, copy, state);
    return article;
  });
  byId("recovery-grid").replaceChildren(...cards);

  const completion = byId("completion-lock");
  const completionIcon = completion.querySelector(".completion-icon");
  const completionText = completion.querySelector("strong");
  if (snapshot.complete) {
    completion.className = "completion-lock is-complete";
    completionIcon.textContent = "✓";
    completionText.textContent = "Recovered · completed state read back after restart";
  } else {
    completion.className = "completion-lock is-locked";
    completionIcon.textContent = "◇";
    completionText.textContent = "Waiting for both recovery signals";
  }
}

function renderTimeline(model, controller, snapshot) {
  const items = model.events.map((event, index) => {
    const item = document.createElement("li");
    const complete = index <= snapshot.cursor;
    const current = index === snapshot.cursor;
    const selected = index === snapshot.selected;
    item.className = [
      "timeline-item",
      complete ? "is-complete" : "",
      current ? "is-current" : "",
      selected ? "is-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    dot.setAttribute("aria-hidden", "true");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "timeline-button";
    button.setAttribute("aria-current", current ? "step" : "false");
    button.addEventListener("click", () => controller.select(index));

    const phase = document.createElement("span");
    phase.className = "timeline-phase";
    phase.textContent = event.phase;
    const title = document.createElement("span");
    title.className = "timeline-title";
    title.textContent = event.title;
    const outcome = document.createElement("span");
    outcome.className = "timeline-outcome";
    outcome.textContent = complete ? `✓ ${event.outcome}` : event.outcome;

    button.append(phase, title, outcome);
    item.append(dot, button);
    return item;
  });
  byId("timeline").replaceChildren(...items);
}

function renderDetail(model, snapshot) {
  const event = model.events[snapshot.selected];
  setText("detail-phase", event.phase);
  setText("detail-title", event.title);
  setText("detail-outcome", event.outcome);
  setText("detail-summary", event.summary);
  setText(
    "detail-evidence-class",
    labelFromIdentifier(event.evidenceClass),
  );
  setText("detail-json", prettyJson(event.sourceJson));

  const pointers = event.jsonPointers.map((pointer) => {
    const item = document.createElement("li");
    item.textContent = pointer;
    return item;
  });
  byId("detail-pointers").replaceChildren(...pointers);
}

function renderReplayState(model, controller, snapshot) {
  renderTimeline(model, controller, snapshot);
  renderDetail(model, snapshot);
  renderGates(model, snapshot);
  renderRecovery(model, snapshot);

  const observed = snapshot.cursor + 1;
  setText("step-count", `${observed} / ${model.events.length} observations`);
  byId("progress-bar").style.width = `${snapshot.progress * 100}%`;

  const playButton = byId("play-button");
  playButton.lastChild.textContent = snapshot.playing ? " Pause replay" : " Play replay";
  playButton.firstElementChild.textContent = snapshot.playing ? "Ⅱ" : "▶";
  byId("next-button").disabled = snapshot.complete;

  const incidentStatus = byId("incident-status");
  if (snapshot.complete) {
    incidentStatus.textContent = model.incident.status;
    incidentStatus.className = "status-recovered";
    setText("replay-state", "Replay complete");
  } else if (snapshot.cursor >= 0) {
    incidentStatus.textContent = "In replay";
    incidentStatus.className = "status-active";
    setText("replay-state", model.events[snapshot.cursor].phase);
  } else {
    incidentStatus.textContent = "Ready";
    incidentStatus.className = "status-neutral";
    setText("replay-state", "Ready to replay");
  }

  if (snapshot.cursor >= 0) {
    setText(
      "live-announcement",
      `Replay step ${snapshot.cursor + 1}: ${model.events[snapshot.cursor].title}`,
    );
  }
}

async function initialise() {
  const response = await fetch("/api/demo", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`proof projection request failed with ${response.status}`);
  }
  const model = await response.json();
  renderStaticModel(model);
  renderFailClosed(model);

  let controller;
  controller = new ReplayState(model.events.length, {
    onChange: (snapshot) => renderReplayState(model, controller, snapshot),
  });

  const togglePlay = () => {
    if (controller.snapshot().playing) {
      controller.pause();
    } else {
      controller.play();
    }
  };

  byId("play-button").addEventListener("click", togglePlay);
  byId("hero-play").addEventListener("click", () => {
    byId("replay").scrollIntoView({ behavior: "smooth", block: "start" });
    controller.play();
  });
  byId("next-button").addEventListener("click", () => controller.next());
  byId("reset-button").addEventListener("click", () => controller.reset());
  byId("copy-event-json").addEventListener("click", (event) => {
    const selected = model.events[controller.snapshot().selected];
    copyText(event.currentTarget, prettyJson(selected.sourceJson), "Copied");
  });

  controller.emit();
}

initialise().catch((error) => {
  setText("replay-state", "Replay unavailable");
  setText("detail-title", "Proof projection could not be loaded");
  setText("detail-summary", error.message);
  setText("detail-json", "{}" );
  console.error(error);
});
