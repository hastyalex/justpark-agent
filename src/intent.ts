import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const anthropic = new Anthropic();
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

export const Intent = z.object({
  destination: z.string(),            // "Twickenham Stadium", "N1 9AG"
  start: z.string(),                  // ISO 8601, Europe/London
  end: z.string(),
  maxPriceGbp: z.number().optional(),
  maxWalkMins: z.number().optional(),
  preferences: z.array(z.string()).default([]), // "EV charging", "covered", "driveway ok"
  autoBook: z.boolean().default(false),         // user said "just book the best one"
});
export type Intent = z.infer<typeof Intent>;

export async function parseIntent(prompt: string): Promise<Intent> {
  const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "full", timeStyle: "short" });
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: `You turn parking requests into a JustPark search. Now: ${now} (Europe/London).
Resolve relative dates ("Saturday", "tomorrow evening"). If no end time is given, infer a sensible one
(match: kick-off -1h to final whistle +1h; dinner: 3h; airport: ask nothing, use stated return).
autoBook=true only if the user explicitly says to just book it.`,
    tools: [{
      name: "search_parking",
      description: "Structured JustPark search",
      input_schema: {
        type: "object",
        properties: {
          destination: { type: "string" },
          start: { type: "string", description: "ISO 8601 with offset" },
          end: { type: "string", description: "ISO 8601 with offset" },
          maxPriceGbp: { type: "number" },
          maxWalkMins: { type: "number" },
          preferences: { type: "array", items: { type: "string" } },
          autoBook: { type: "boolean" },
        },
        required: ["destination", "start", "end"],
      },
    }],
    tool_choice: { type: "tool", name: "search_parking" },
    messages: [{ role: "user", content: prompt }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  if (!call || call.type !== "tool_use") throw new Error("Could not parse request");
  return Intent.parse(call.input);
}

export type Listing = {
  id: string; title: string; url: string; priceGbp: number;
  walkMins?: number; rating?: number; features: string[];
};

/** Pull listings out of raw page text so we're not hostage to JustPark's CSS class names. */
export async function extractListings(pageText: string, links: { text: string; href: string }[]): Promise<Listing[]> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: "Extract parking listings from a JustPark search results page. Only use URLs from the provided links list. Return via the tool.",
    tools: [{
      name: "listings",
      description: "Parsed listings",
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" }, url: { type: "string" }, priceGbp: { type: "number" },
                walkMins: { type: "number" }, rating: { type: "number" },
                features: { type: "array", items: { type: "string" } },
              },
              required: ["title", "url", "priceGbp"],
            },
          },
        },
        required: ["items"],
      },
    }],
    tool_choice: { type: "tool", name: "listings" },
    messages: [{
      role: "user",
      content: `PAGE TEXT:\n${pageText.slice(0, 60_000)}\n\nLINKS:\n${JSON.stringify(links.slice(0, 300))}`,
    }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  const items = (call && call.type === "tool_use" ? (call.input as any).items : []) as Omit<Listing, "id">[];
  return items.map((l, i) => ({ ...l, features: l.features ?? [], id: String(i + 1) }));
}

export function rank(listings: Listing[], intent: Intent): Listing[] {
  const cap = Math.min(intent.maxPriceGbp ?? Infinity, Number(process.env.MAX_PRICE_GBP ?? Infinity));
  const prefs = intent.preferences.map((p) => p.toLowerCase());
  return listings
    .filter((l) => l.priceGbp <= cap)
    .filter((l) => intent.maxWalkMins == null || l.walkMins == null || l.walkMins <= intent.maxWalkMins)
    .map((l) => {
      const prefHits = prefs.filter((p) => l.features.some((f) => f.toLowerCase().includes(p))).length;
      // cheap + close + well-rated, with a bonus for matching preferences
      const score = -l.priceGbp - 0.5 * (l.walkMins ?? 10) + 2 * (l.rating ?? 4) + 5 * prefHits;
      return { l, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ l }) => l)
    .slice(0, 5);
}
