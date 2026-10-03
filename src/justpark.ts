import type { Page } from "playwright";
import fs from "node:fs";
import type { Intent, Listing } from "./intent.js";
import { AUTH_FILE, SessionError, dismissCookies, launch, login, newContext, shot } from "./auth.js";

async function ensureSession() {
  if (fs.existsSync(AUTH_FILE)) return;
  const r = await login();
  if (r.status === "needs_code") throw new SessionError("needs_code", "JustPark sent you a verification code — send it to me to finish logging in.");
}

/** Runs fn with a logged-in page. If JustPark bounced us to login mid-flow, re-login once and retry. */
async function withPage<T>(label: string, fn: (page: Page) => Promise<T>, retried = false): Promise<T> {
  await ensureSession();
  const browser = await launch();
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  try {
    const out = await fn(page);
    await ctx.storageState({ path: AUTH_FILE }).catch(() => {}); // keep cookies fresh
    return out;
  } catch (e) {
    const s = await shot(page, `error-${label}`);
    const bounced = /login|sign-?in/i.test(page.url());
    await browser.close();
    if (bounced && !retried) {
      fs.rmSync(AUTH_FILE, { force: true });
      return withPage(label, fn, true);
    }
    if (e instanceof SessionError) throw e;
    throw new Error(`${(e as Error).message} (screenshot ${s})`);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** "2026-10-27T07:00" in UK local time, as JustPark's search URL expects */
function jpTime(iso: string) {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return iso.slice(0, 16); // no offset: already local wall-clock time
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Drive the public search UI (no partner API exists for driver bookings). */
export async function search(intent: Intent) {
  return withPage("search", async (page) => {
    await page.goto("https://www.justpark.com/", { waitUntil: "domcontentloaded" });
    await dismissCookies(page);

    const where = page.getByPlaceholder(/where|search|postcode|destination/i).first();
    await where.fill(intent.destination);
    await page.getByRole("option").first().click({ timeout: 8000 }).catch(() => where.press("Enter"));
    // The site routes client-side, so wait for the real results URL rather than reading whatever page is open
    await page.waitForURL(/\/search\?/, { timeout: 15_000 }).catch(() => {});

    // Build the results URL ourselves, e.g. /search?arriving=2026-10-27T07:00&leaving=…&q=…&coords=…&place_id=…
    // keeping the place details JustPark resolved. Param names are env-configurable from Railway.
    const found = new URL(page.url());
    const url = new URL("https://www.justpark.com/search");
    for (const k of ["q", "coords", "place_id", "filters"]) {
      const v = found.searchParams.get(k);
      if (v) url.searchParams.set(k, v);
    }
    if (!url.searchParams.has("q")) url.searchParams.set("q", intent.destination);
    url.searchParams.set(process.env.JP_PARAM_START ?? "arriving", jpTime(intent.start));
    url.searchParams.set(process.env.JP_PARAM_END ?? "leaving", jpTime(intent.end));
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    const screenshot = await shot(page, "results");

    const text = await page.locator("body").innerText();
    const links = await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 120), href: (a as HTMLAnchorElement).href }))
        .filter((l) => /justpark\.com\/.*(parking|space|listing)/i.test(l.href)));
    return { text, links, searchUrl: page.url(), screenshot };
  });
}

export async function book(listing: Listing, _intent: Intent, opts: { dryRun: boolean }) {
  return withPage("book", async (page) => {
    await page.goto(listing.url, { waitUntil: "networkidle" });
    await dismissCookies(page);

    await page.getByRole("button", { name: /^(book|reserve|book now|continue)/i }).first().click();
    await page.waitForLoadState("networkidle");

    const body = await page.locator("body").innerText();
    const total = Number((body.match(/total[^£]*£\s?(\d+(?:\.\d{2})?)/i) ?? [])[1]);
    if (!Number.isFinite(total)) throw new Error("Couldn't read checkout total; aborting for safety.");
    if (total > listing.priceGbp * 1.1 + 0.5) throw new Error(`Price changed: £${total} vs £${listing.priceGbp} quoted.`);

    const vehicle = page.getByRole("radio").first();
    if (await vehicle.isVisible({ timeout: 1500 }).catch(() => false)) await vehicle.check().catch(() => {});

    const screenshot = await shot(page, "checkout");
    if (opts.dryRun) return { status: "dry_run" as const, total, screenshot };

    await page.getByRole("button", { name: /^(pay|confirm|complete|book) .*|^pay$|^confirm booking$/i }).last().click();

    const challenged = await page.frameLocator("iframe[src*='3ds'], iframe[name*='challenge']").locator("body")
      .isVisible({ timeout: 5000 }).catch(() => false);
    if (challenged) return { status: "needs_3ds" as const, total, url: page.url(), screenshot: await shot(page, "3ds") };

    await page.getByText(/booking (confirmed|reference)|you're booked|confirmed/i).first().waitFor({ timeout: 30_000 });
    const done = await page.locator("body").innerText();
    const ref = (done.match(/(?:booking )?(?:ref(?:erence)?|id)[:\s#]*([A-Z0-9-]{5,})/i) ?? [])[1];
    return { status: "booked" as const, total, reference: ref ?? null, url: page.url(), screenshot: await shot(page, "confirmed") };
  });
}
