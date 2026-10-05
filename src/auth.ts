// Server-side login so no computer is ever needed.
// Handles: auto-login with stored credentials, a pause for 2FA codes you send from your phone,
// and screenshots of every step you can view in Safari.
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR ?? "./data"; // mount a Railway volume here
export const SHOTS_DIR = path.join(DATA_DIR, "shots");
const AUTH_FILE = path.join(DATA_DIR, "auth.json"); // cookies saved by older versions, used once to seed the profile
const PROFILE_DIR = path.join(DATA_DIR, "profile");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const LOGIN_URL = process.env.JP_LOGIN_URL ?? "https://www.justpark.com/login";
const ACCOUNT_URL = process.env.JP_ACCOUNT_URL ?? "https://www.justpark.com/dashboard";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export class SessionError extends Error {
  constructor(public status: "needs_code" | "blocked" | "failed", message: string) { super(message); }
}

/**
 * One browser profile kept on the volume, like your own Safari: cookies, storage and cache survive between runs,
 * so JustPark keeps you logged in and the app rarely has to log in again (logins are where CAPTCHAs appear).
 * Only one can be open at a time; the server already runs one job at a time.
 */
export async function openProfile(): Promise<BrowserContext> {
  if (pending) throw new SessionError("failed", "A login is waiting for you (CAPTCHA or code). Finish it on the control page, or wait 10 min.");
  const fresh = !fs.existsSync(PROFILE_DIR);
  // Clear lock files left by a crash or a redeploy onto a new machine; we never open the profile twice
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) fs.rmSync(path.join(PROFILE_DIR, f), { force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true, args: ["--disable-blink-features=AutomationControlled"],
    locale: "en-GB", timezoneId: "Europe/London", userAgent: UA, viewport: { width: 1280, height: 900 },
  });
  if (fresh && fs.existsSync(AUTH_FILE)) {
    const { cookies } = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    await ctx.addCookies(cookies).catch(() => {});
  }
  return ctx;
}

const firstPage = async (ctx: BrowserContext) => ctx.pages()[0] ?? ctx.newPage();

export async function shot(page: Page, label: string) {
  const file = path.join(SHOTS_DIR, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  const all = fs.readdirSync(SHOTS_DIR).sort();
  all.slice(0, Math.max(0, all.length - 30)).forEach((f) => fs.rmSync(path.join(SHOTS_DIR, f)));
  return path.basename(file);
}

// isVisible() ignores its timeout and checks once — this actually waits
export const visible = (l: Locator, timeout: number) => l.waitFor({ state: "visible", timeout }).then(() => true, () => false);

export async function dismissCookies(page: Page) {
  // JustPark's banner is Ethyca Fides; fall back to generic button text
  const btn = page.locator(".fides-reject-all-button, .fides-accept-all-button")
    .or(page.getByRole("button", { name: /only necessary|accept all|accept|agree|got it/i })).first();
  if (await visible(btn, 8000)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

const onLoginPage = async (page: Page) =>
  /login|sign-?in/i.test(page.url()) || (await page.locator("input[type=password]").isVisible().catch(() => false));

// The challenge itself, not the always-present reCAPTCHA badge
const captchaShown = (page: Page, timeout: number) =>
  visible(page.locator("iframe[src*='recaptcha'][src*='bframe'], iframe[src*='hcaptcha'][src*='challenge'], iframe[src*='challenges.cloudflare.com']")
    .or(page.getByText(/verify you are human/i)).filter({ visible: true }).first(), timeout);

const codeInput = (page: Page) =>
  page.locator("input[autocomplete='one-time-code'], input[name*='code' i], input[id*='code' i], input[inputmode='numeric']").first();

/** Is the saved session still good? */
export async function checkSession(): Promise<{ loggedIn: boolean; screenshot: string }> {
  const ctx = await openProfile();
  try {
    const page = await firstPage(ctx);
    await page.goto(ACCOUNT_URL, { waitUntil: "networkidle" });
    await dismissCookies(page);
    return { loggedIn: !(await onLoginPage(page)), screenshot: await shot(page, "session-check") };
  } finally { await ctx.close(); }
}

// A login paused waiting for you: a 2FA code, or a CAPTCHA you solve by tapping a live view
let pending: { ctx: BrowserContext; page: Page; timer: NodeJS.Timeout } | null = null;
const clearPending = async () => {
  if (!pending) return;
  clearTimeout(pending.timer);
  const { ctx } = pending;
  pending = null;
  await ctx.close().catch(() => {});
};
const hold = (ctx: BrowserContext, page: Page) => {
  if (pending) clearTimeout(pending.timer);
  pending = { ctx, page, timer: setTimeout(clearPending, 10 * 60_000) };
};

async function submitForm(page: Page) {
  // Submit via the form itself — button-name matching can hit "Continue with Google/Apple" first
  const submit = page.locator("form:has(input[type=password]) button[type=submit]").first();
  if (await submit.isVisible().catch(() => false)) await submit.click();
  else await page.locator("input[type=password]").first().press("Enter");
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function finish(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.goto(ACCOUNT_URL, { waitUntil: "networkidle" });
  const s = await shot(page, "after-login");
  if (await onLoginPage(page)) throw new SessionError("failed", `Login didn't stick — see screenshot ${s}`);
  return { status: "ok" as const, screenshot: s };
}

export async function login() {
  const email = process.env.JUSTPARK_EMAIL, password = process.env.JUSTPARK_PASSWORD;
  if (!email || !password) throw new SessionError("failed", "Set JUSTPARK_EMAIL and JUSTPARK_PASSWORD in Railway.");
  await clearPending();

  const ctx = await openProfile();
  const page = await firstPage(ctx);
  try {
    // The profile may still be logged in; don't log in again if so
    await page.goto(ACCOUNT_URL, { waitUntil: "networkidle" });
    if (!(await onLoginPage(page))) {
      const s = await shot(page, "already-logged-in");
      await ctx.close();
      return { status: "ok" as const, screenshot: s };
    }
    await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
    await dismissCookies(page);

    const emailChoice = page.getByText(/log ?in with email|sign ?in with email|continue with email/i).first();
    if (await visible(emailChoice, 10_000)) {
      await emailChoice.click();
      await page.waitForTimeout(800);
    }
    const emailInput = page.locator("input[type=email], input[name*='email' i]").first();
    await emailInput.fill(email, { timeout: 15_000 });
    const pw = page.locator("input[type=password]").first();
    if (!(await visible(pw, 1500))) {
      // two-step form: email first, then password
      await emailInput.press("Enter");
    }
    await pw.fill(password);
    await submitForm(page);
    await shot(page, "login-submitted");

    if (await captchaShown(page, 6000)) {
      const s = await shot(page, "needs-captcha");
      hold(ctx, page);
      return { status: "needs_captcha" as const, screenshot: s };
    }

    if (await visible(codeInput(page), 4000)) {
      const s = await shot(page, "needs-code");
      hold(ctx, page);
      return { status: "needs_code" as const, screenshot: s };
    }

    const result = await finish(page);
    await ctx.close();
    return result;
  } catch (e) {
    if (!pending) {
      await shot(page, "login-error");
      await ctx.close().catch(() => {});
    }
    throw e;
  }
}

export async function submitCode(code: string) {
  if (!pending) throw new SessionError("failed", "No login is waiting for a code (they expire after 10 min). Run the login again.");
  const { page } = pending;
  try {
    await codeInput(page).fill(code.trim());
    await page.getByRole("button", { name: /verify|confirm|continue|submit|log ?in/i }).first().click().catch(() => page.keyboard.press("Enter"));
    return await finish(page);
  } finally { await clearPending(); }
}

const needPending = () => {
  if (!pending) throw new SessionError("failed", "No login is waiting (they expire after 10 min). Tap Log in again.");
  return pending;
};

/** What the paused login's browser is showing right now (1280×900, coordinates match tap()) */
export async function liveScreen() {
  return needPending().page.screenshot({ type: "jpeg", quality: 70 });
}

/** Click the paused login's page at a point on the liveScreen() image */
export async function tap(x: number, y: number) {
  const p = needPending();
  hold(p.ctx, p.page); // each tap restarts the 10-minute timer
  await p.page.mouse.click(x, y);
  await p.page.waitForTimeout(800);
}

/** After you've solved the CAPTCHA: carry on with the login */
export async function continueLogin() {
  const { page } = needPending();
  await page.waitForLoadState("networkidle").catch(() => {});
  if (await captchaShown(page, 1500)) return { status: "needs_captcha" as const, screenshot: await shot(page, "needs-captcha") };
  if (await visible(codeInput(page), 2000)) return { status: "needs_code" as const, screenshot: await shot(page, "needs-code") };

  // Solving usually submits the form; if we're still on it, submit again
  if (await page.locator("input[type=password]").first().isVisible().catch(() => false)) {
    await submitForm(page);
    if (await captchaShown(page, 4000)) return { status: "needs_captcha" as const, screenshot: await shot(page, "needs-captcha") };
    if (await visible(codeInput(page), 3000)) return { status: "needs_code" as const, screenshot: await shot(page, "needs-code") };
  }
  try { return await finish(page); }
  finally { await clearPending(); }
}
