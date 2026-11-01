import { describe, expect, it } from "vitest";
import { parseVideoRequest } from "@/server/bot";

describe("parseVideoRequest", () => {
  it("reads minutes, hours and style", () => {
    expect(parseVideoRequest("make a 10 minute video about how robots learn to walk")).toEqual({
      topic: "how robots learn to walk",
      minutes: 10,
      style: "real",
    });
    expect(parseVideoRequest("1.5 hour cartoon video about the history of coffee")).toEqual({
      topic: "history of coffee",
      minutes: 90,
      style: "cartoon",
    });
    expect(parseVideoRequest("1 hour 30 minutes: why AI makes mistakes")?.minutes).toBe(90);
  });
  it("caps the length and defaults to 10 minutes", () => {
    expect(parseVideoRequest("5 hours video about space")?.minutes).toBe(90);
    expect(parseVideoRequest("video about deep sea creatures")?.minutes).toBe(10);
  });
  it("ignores empty or too-short requests", () => {
    expect(parseVideoRequest("   ")).toBeNull();
    expect(parseVideoRequest("hi")).toBeNull();
  });
});
