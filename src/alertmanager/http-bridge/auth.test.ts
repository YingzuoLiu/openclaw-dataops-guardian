import { describe, expect, it } from "vitest";

import { extractBearerToken, isValidBearerToken } from "./auth.js";

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("returns undefined when the header is missing", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic abc123")).toBeUndefined();
  });

  it("returns undefined for an empty token", () => {
    expect(extractBearerToken("Bearer ")).toBeUndefined();
  });

  it("takes the first value when the header repeats", () => {
    expect(extractBearerToken(["Bearer first", "Bearer second"])).toBe("first");
  });
});

describe("isValidBearerToken", () => {
  const expectedToken = "correct-horse-battery-staple";

  it("accepts the exact configured token", () => {
    expect(isValidBearerToken(expectedToken, expectedToken)).toBe(true);
  });

  it("rejects an incorrect token of the same length", () => {
    const wrong = "correct-horse-battery-staplf";
    expect(wrong.length).toBe(expectedToken.length);
    expect(isValidBearerToken(wrong, expectedToken)).toBe(false);
  });

  it("rejects a shorter token", () => {
    expect(isValidBearerToken("short", expectedToken)).toBe(false);
  });

  it("rejects a longer token", () => {
    expect(isValidBearerToken(`${expectedToken}-extra`, expectedToken)).toBe(false);
  });

  it("rejects an undefined token", () => {
    expect(isValidBearerToken(undefined, expectedToken)).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidBearerToken("", expectedToken)).toBe(false);
  });
});
