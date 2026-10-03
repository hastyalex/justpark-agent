// Server-side login so no computer is ever needed.
// Handles: auto-login with stored credentials, a pause for 2FA codes you send from your phone,
// and screenshots of every step you can view in Safari.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR ?? "./data"; // mount a Railway volume here
export const SHOTS_DIR = path.join(DATA_DIR, "shots");
export const AUTH_FILE = path.join(DATA_DIR, "auth.json");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const LOGIN_URL = process.env.JP_LOGIN_URL ?? "https://www.justpark.com/login";
const ACCOUNT_URL = process.env.JP_ACCOUNT_URL ?? "https://www.justpark.com/dashboard";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export class SessionError extends Error {
  constructor(public status: "needs_code" | "blocked" | "failed", message: string) { super(message); }
}

export const launch = () => chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });

export const newContext = (browser: Browser, withSession = true) =>
  browser.newContext({
    storageState: withSession && fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
    locale: "en-GB", timezoneId: "Europe/London", userAgent: UA, viewport: { width: 1280, height: 900 },
  });

export async function shot(page: Page, label: string) {
  const file = path.join(SHOTS_DIR, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  const all = fs.readdirSync(SHOTS_DIR).sort();
  all.slice(0, Math.max(0, all.length - 30)).forEach((f) => fs.rmSync(path.join(SHOTS_DIR, f)));
  return path.basename(file);
}

export async function dismissCookies(page: Page) {
  const btn = page.getByRole("button", { name: /accept( all)?|agree|got it/i }).first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
}

const onLoginPage = async (page: Page) =>
  /login|sign-?in/i.test(page.url()) || (await page.locator("input[type=password]").isVisible().catch(() => false));

const captcha = (page: Page) =>
  page.locator("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], text=/verify you are human/i")
    .first().isVisible({ timeout: 2000 }).catch(() => false);

const codeInput = (page: Page) =>
  page.locator("input[autocomplete='one-time-code'], input[name*='code' i], input[id*='code' i], input[inputmode='numeric']").first();

/** Is the saved session still good? */
export async function checkSession(): Promise<{ loggedIn: boolean; screenshot: string }> {
  const browser = await launch();
  try {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await page.goto(ACCOUNT_URL, { waitUntil: "networkidle" });
    await dismissCookies(page);
    return { loggedIn: !(await onLoginPage(page)), screenshot: await shot(page, "session-check") };
  } finally { await browser.close(); }
}

// A login paused waiting for your 2FA code
let pending: { browser: Browser; ctx: BrowserContext; page: Page; timer: NodeJS.Timeout } | null = null;
const clearPending = async () => {
  if (!pending) return;
  clearTimeout(pending.timer);
  await pending.browser.close().catch(() => {});
  pending = null;
};

async function finish(page: Page, ctx: BrowserContext) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.goto(ACCOUNT_URL, { waitUntil: "networkidle" });
  const s = await shot(page, "after-login");
  if (await onLoginPage(page)) throw new SessionError("failed", `Login didn't stick — see screenshot ${s}`);
  await ctx.storageState({ path: AUTH_FILE });
  return { status: "ok" as const, screenshot: s };
}

export async function login() {
  const email = process.env.JUSTPARK_EMAIL, password = process.env.JUSTPARK_PASSWORD;
  if (!email || !password) throw new SessionError("failed", "Set JUSTPARK_EMAIL and JUSTPARK_PASSWORD in Railway.");
  await clearPending();

  const browser = await launch();
  const ctx = await newContext(browser, false);
  const page = await ctx.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
    await dismissCookies(page);

    await page.locator("input[type=email], input[name*='email' i]").first().fill(email);
    const pw = page.locator("input[type=password]").first();
    if (!(await pw.isVisible({ timeout: 1500 }).catch(() => false))) {
      // two-step form: email first, then password
      await page.getByRole("button", { name: /continue|next/i }).first().click();
    }
    await pw.fill(password);
    await page.getByRole("button", { name: /log ?in|sign ?in|continue/i }).first().click();
    await page.waitForLoadState("networkidle").catch(() => {});

    if (await captcha(page)) {
      const s = await shot(page, "captcha");
      await browser.close();
      throw new SessionError("blocked", `JustPark showed a CAPTCHA (screenshot ${s}). Wait an hour and try again.`);
    }

    if (await codeInput(page).isVisible({ timeout: 4000 }).catch(() => false)) {
      const s = await shot(page, "needs-code");
      pending = { browser, ctx, page, timer: setTimeout(clearPending, 10 * 60_000) };
      return { status: "needs_code" as const, screenshot: s };
    }

    const result = await finish(page, ctx);
    await browser.close();
    return result;
  } catch (e) {
    if (!pending) await browser.close().catch(() => {});
    throw e;
  }
}

export async function submitCode(code: string) {
  if (!pending) throw new SessionError("failed", "No login is waiting for a code (they expire after 10 min). Run the login again.");
  const { page, ctx } = pending;
  try {
    await codeInput(page).fill(code.trim());
    await page.getByRole("button", { name: /verify|confirm|continue|submit|log ?in/i }).first().click().catch(() => page.keyboard.press("Enter"));
    return await finish(page, ctx);
  } finally { await clearPending(); }
}
