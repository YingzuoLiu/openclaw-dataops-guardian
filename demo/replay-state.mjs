export class ReplayState {
  constructor(
    length,
    {
      delayMs = 420,
      schedule = (callback, delay) => setTimeout(callback, delay),
      cancel = (handle) => clearTimeout(handle),
      onChange = () => {},
    } = {},
  ) {
    if (!Number.isInteger(length) || length < 1) {
      throw new Error("replay length must be a positive integer");
    }
    this.length = length;
    this.delayMs = delayMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onChange = onChange;
    this.cursor = -1;
    this.selected = 0;
    this.playing = false;
    this.timer = undefined;
  }

  snapshot() {
    return {
      cursor: this.cursor,
      selected: this.selected,
      playing: this.playing,
      complete: this.cursor === this.length - 1,
      progress: (this.cursor + 1) / this.length,
    };
  }

  emit() {
    this.onChange(this.snapshot());
  }

  select(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error("selected replay step is out of range");
    }
    this.selected = index;
    this.emit();
  }

  next() {
    if (this.cursor >= this.length - 1) {
      this.pause();
      return false;
    }
    this.cursor += 1;
    this.selected = this.cursor;
    if (this.cursor === this.length - 1) {
      this.playing = false;
    }
    this.emit();
    return true;
  }

  play() {
    if (this.playing) {
      return;
    }
    if (this.cursor === this.length - 1) {
      this.reset();
    }
    this.playing = true;
    this.next();
    if (this.cursor < this.length - 1) {
      this.queueNext();
    }
  }

  queueNext() {
    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (!this.playing) {
        return;
      }
      this.next();
      if (this.playing && this.cursor < this.length - 1) {
        this.queueNext();
      }
    }, this.delayMs);
  }

  pause() {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    const changed = this.playing;
    this.playing = false;
    if (changed) {
      this.emit();
    }
  }

  reset() {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.cursor = -1;
    this.selected = 0;
    this.playing = false;
    this.emit();
  }
}
