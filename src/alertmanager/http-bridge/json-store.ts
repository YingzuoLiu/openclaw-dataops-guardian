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
 * `fs.writeSync` is not guaranteed to write the entire buffer in one call
 * (short writes are permitted by the underlying syscall, e.g. when a signal
 * interrupts it). Loop until every byte has actually been written.
 */
function writeFullySync(fd: number, data: string): void {
  const buffer = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

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
    writeFullySync(fd, serialized);
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
 * append-only audit trail that is never read back by the bridge itself. The
 * containing directory is fsynced the first time this call creates `path`,
 * so the directory entry for a brand-new audit file itself survives a
 * crash; that extra fsync is skipped on subsequent appends to an existing
 * file, since the directory entry is already durable.
 */
export function appendJsonLineDurable(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const isNewFile = !existsSync(path);
  const line = `${JSON.stringify(value)}\n`;
  const fd = openSync(path, "a");
  try {
    writeFullySync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  if (isNewFile) {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

/**
 * Returns `undefined` only when `path` does not exist at all — the
 * legitimate "nothing persisted yet" case. A file that exists but is empty
 * (or contains anything else `JSON.parse` rejects) is a corruption signal,
 * not a fresh start: `JSON.parse` is left to throw for it so the caller
 * fails closed instead of silently reinitializing over lost state.
 */
export function readJsonFileOrUndefined(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8"));
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
