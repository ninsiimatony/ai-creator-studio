import { describe, expect, it } from "vitest";
import { dnaLine, nearest, quantize, dequantize, trigramJaccard, BANNED_NAMES } from "@/server/variety";

describe("variety engine", () => {
  it("finds the closest earlier story by meaning-vector", () => {
    const a = quantize([1, 0, 0, 0]);
    const pool = [
      { text: "same", vec: dequantize(quantize([0.99, 0.05, 0, 0])) },
      { text: "other", vec: dequantize(quantize([0, 1, 0, 0])) },
    ];
    const n = nearest(a, pool);
    expect(n.text).toBe("same");
    expect(n.score).toBeGreaterThan(0.95);
  });
  it("spots titles that reuse the same words", () => {
    expect(trigramJaccard("The Night My Husband Cried", "The Night My Husband Left")).toBeGreaterThan(0.3);
    expect(trigramJaccard("Snow In Hokkaido", "A Letter From Lagos")).toBe(0);
  });
  it("writes a readable DNA line for both channels", () => {
    expect(dnaLine(1, { setting: "x", era: "today", protagonist: "nurse", relationship: "twins", theme: "t", inciting: "i", twist: "w", ending: "e", pov: "p", names: "A, B, C" })).toContain("names to use: A, B, C");
    expect(dnaLine(2, { location: "a clock tower", season: "s", fear: "f", guest: "g", goblinRole: "r", twist: "t", ending: "e", names: "Tobi, Asha" })).toContain("a clock tower");
    expect(BANNED_NAMES).toContain("Elara");
  });
});
