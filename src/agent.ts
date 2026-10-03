import { randomUUID } from "node:crypto";
import { parseIntent, extractListings, rank, type Intent, type Listing } from "./intent.js";
import * as jp from "./justpark.js";

type Plan = { intent: Intent; options: Listing[]; searchUrl: string; expires: number };
const plans = new Map<string, Plan>(); // swap for Upstash Redis if you want plans to survive restarts

const dryRun = () => process.env.DRY_RUN !== "false";

export async function plan(prompt: string) {
  const intent = await parseIntent(prompt);
  const { text, links, searchUrl, screenshot } = await jp.search(intent);
  const options = rank(await extractListings(text, links), intent);
  if (!options.length) return { message: `Nothing on JustPark near ${intent.destination} within your limits.`, intent, searchUrl, screenshot };

  const planId = randomUUID().slice(0, 8);
  plans.set(planId, { intent, options, searchUrl, expires: Date.now() + 15 * 60_000 });

  if (intent.autoBook) return confirm(planId, options[0].id);

  const lines = options.map((o) =>
    `${o.id}. ${o.title} — £${o.priceGbp.toFixed(2)}${o.walkMins ? `, ${o.walkMins} min walk` : ""}${o.features.length ? ` (${o.features.slice(0, 3).join(", ")})` : ""}`);
  return {
    planId,
    intent,
    options,
    screenshot,
    message: `${fmt(intent.start)} → ${fmt(intent.end)} near ${intent.destination}:\n${lines.join("\n")}\n\nReply with a number to book.`,
  };
}

export async function confirm(planId: string, optionId: string) {
  const p = plans.get(planId);
  if (!p || p.expires < Date.now()) throw new Error("That search has expired — ask again.");
  const listing = p.options.find((o) => o.id === optionId);
  if (!listing) throw new Error(`No option ${optionId}.`);
  const result = await jp.book(listing, p.intent, { dryRun: dryRun() });
  plans.delete(planId);

  const message =
    result.status === "booked" ? `✅ Booked ${listing.title}, £${result.total.toFixed(2)}. Ref ${result.reference ?? "(see email)"}.`
    : result.status === "needs_3ds" ? `Your bank wants 3-D Secure — finish here: ${result.url}`
    : `🧪 Dry run: would pay £${result.total.toFixed(2)} for ${listing.title}. Set DRY_RUN=false to go live.`;
  return { ...result, listing, message };
}

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
