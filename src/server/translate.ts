// Free translation with Cloudflare Workers AI (Meta m2m100). Used to give each video a title and
// description in more languages, so YouTube can show it to viewers in more countries.
import type { AiBinding } from "./db";

export const TRANSLATE_MODEL = "@cf/meta/m2m100-1.2b";

/** Translates each text into each language. A language that fails is simply left out (never throws). */
export async function translateAll(ai: AiBinding, texts: string[], langs: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const lang of langs) {
    try {
      const res: string[] = [];
      for (const text of texts) {
        const r = (await ai.run(TRANSLATE_MODEL, { text, source_lang: "en", target_lang: lang })) as { translated_text?: unknown } | null;
        const t = typeof r?.translated_text === "string" ? r.translated_text.trim() : "";
        if (!t) throw new Error("empty translation");
        res.push(t);
      }
      out[lang] = res;
    } catch (e) {
      console.error("translation failed for", lang, e);
    }
  }
  return out;
}
