import { describe, expect, it } from "vitest";
import { fetchDocClip, isFreeLicence, sourceOrder, sourcesLine } from "@/server/clips";
import { parseVideoRequest } from "@/server/bot";
import { dnaLine } from "@/server/variety";

describe("channel 3 clip finder", () => {
  it("accepts only CC0 / public-domain licences", () => {
    expect(isFreeLicence("CC0")).toBe(true);
    expect(isFreeLicence("Public domain")).toBe(true);
    expect(isFreeLicence("PD-USGov-NASA")).toBe(true);
    expect(isFreeLicence("CC BY-SA 4.0")).toBe(false);
    expect(isFreeLicence("CC BY 3.0")).toBe(false);
    expect(isFreeLicence("")).toBe(false);
  });
  it("starts with NASA for space scenes and the archive for old-world scenes", () => {
    expect(sourceOrder("the surface of the moon", 0)[0]).toBe("nasa");
    expect(sourceOrder("old farm life in the 1950s", 0)[0]).toBe("archive");
    expect(sourceOrder("a humpback whale", 0)[0]).toBe("pexels");
    expect(sourceOrder("a humpback whale", 1)[0]).toBe("pixabay");
    expect(sourceOrder("a humpback whale", 3)[0]).toBe("wikimedia");
  });
  it("names only the sources really used", () => {
    expect(sourcesLine(["pexels", "nasa", "pexels"])).toContain("Pexels");
    expect(sourcesLine(["pexels", "nasa"])).toContain("NASA");
    expect(sourcesLine([])).toBe("");
  });
  it("downloads a Pexels clip and skips clips an earlier video used", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.pexels.com/videos/search"))
        return Response.json({
          videos: [
            { id: 1, user: { name: "A" }, video_files: [{ width: 1280, link: "https://cdn.test/one.mp4", file_type: "video/mp4" }] },
            { id: 2, user: { name: "B" }, video_files: [{ width: 1280, link: "https://cdn.test/two.mp4", file_type: "video/mp4" }] },
          ],
        });
      if (url.startsWith("https://cdn.test/")) return new Response(new Uint8Array(5000), { headers: { "content-length": "5000" } });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const clip = await fetchDocClip({ pexelsKey: "k", pixabayKey: undefined, text: "a whale swims", query: "whale", exclude: ["pexels:1"], fetcher });
    expect(clip.key).toBe("pexels:2");
    expect(clip.source).toBe("pexels");
    expect(clip.bytes.length).toBe(5000);
    expect(calls.some((u) => u.includes("one.mp4"))).toBe(false);
  });
  it("throws a clear error when no source has a clip", async () => {
    const fetcher = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchDocClip({ pexelsKey: "k", pixabayKey: "p", text: "a whale", query: "whale", fetcher })).rejects.toThrow(/No free clip/);
  });
});

describe("channel 3 requests", () => {
  it("Telegram 'channel 3' asks for the documentary style", () => {
    const r = parseVideoRequest("channel 3 how octopuses hide");
    expect(r?.channel).toBe(3);
    expect(r?.tone).toBe("wonder");
    expect(r?.topic.toLowerCase()).toContain("octopuses");
    expect(r?.topic.toLowerCase()).not.toContain("channel");
  });
  it("writes a readable DNA line for channel 3", () => {
    expect(dnaLine(3, { subject: "sea turtles", angle: "how it sleeps", hook: "start with a question" })).toContain("sea turtles");
  });
});
