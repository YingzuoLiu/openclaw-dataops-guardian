import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Durably writes JSON to `path`: write to a sibling temp file, fsync the temp
 * file's contents, rename over the destination (atomic on the same
 * filesystem), then fsync the containing directory so the rename itself
 * survives a crash. A reader can never observe a partially written file.
 */
export function writeJsonFileDurable(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, path);

  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * Appends one JSON-serialized line to `path`, fsyncing the file after the
 * write. Appends are not made atomic the way `writeJsonFileDurable` is
 * (a crash mid-write can leave a torn trailing line, which readers should
 * tolerate by skipping an unparsable final line); this is acceptable for an
 * append-only audit trail that is never read back by the bridge itself.
 */
export function appendJsonLineDurable(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJsonFileOrUndefined(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(raw);
}

/**
 * Removes `path` if present. Not finding the file is treated as success so
 * that a checkpoint-deletion retry after a crash is idempotent.
 */
export function deleteFileIfPresent(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
