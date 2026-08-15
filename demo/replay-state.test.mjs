import { describe, expect, it, vi } from "vitest";

import { ReplayState } from "./replay-state.mjs";

describe("ReplayState", () => {
  it("steps deterministically and resets to the same initial state", () => {
    const updates = [];
    const state = new ReplayState(3, {
      onChange: (snapshot) => updates.push(snapshot),
    });

    expect(state.snapshot()).toEqual({
      cursor: -1,
      selected: 0,
      playing: false,
      complete: false,
      progress: 0,
    });
    expect(state.next()).toBe(true);
    expect(state.next()).toBe(true);
    state.select(0);
    state.reset();

    expect(state.snapshot()).toEqual({
      cursor: -1,
      selected: 0,
      playing: false,
      complete: false,
      progress: 0,
    });
    expect(updates.length).toBe(4);
  });

  it("plays every observation without a wall-clock wait", () => {
    const queue = [];
    const schedule = vi.fn((callback) => {
      queue.push(callback);
      return callback;
    });
    const cancel = vi.fn();
    const state = new ReplayState(3, { schedule, cancel });

    state.play();
    expect(state.snapshot()).toMatchObject({ cursor: 0, playing: true });
    queue.shift()();
    expect(state.snapshot()).toMatchObject({ cursor: 1, playing: true });
    queue.shift()();
    expect(state.snapshot()).toMatchObject({
      cursor: 2,
      playing: false,
      complete: true,
    });
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued replay on reset", () => {
    const cancel = vi.fn();
    const state = new ReplayState(2, {
      schedule: (callback) => callback,
      cancel,
    });
    state.timer = "queued-handle";
    state.playing = true;

    state.reset();

    expect(cancel).toHaveBeenCalledWith("queued-handle");
    expect(state.snapshot()).toMatchObject({ cursor: -1, playing: false });
  });

  it("finishes in one update for reduced-motion playback", () => {
    const cancel = vi.fn();
    const onChange = vi.fn();
    const state = new ReplayState(4, { cancel, onChange });
    state.timer = "queued-handle";
    state.playing = true;

    state.finish();

    expect(cancel).toHaveBeenCalledWith("queued-handle");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(state.snapshot()).toEqual({
      cursor: 3,
      selected: 3,
      playing: false,
      complete: true,
      progress: 1,
    });
  });
});
