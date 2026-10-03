import express from "express";
import fs from "node:fs";
import path from "node:path";
import { plan, confirm } from "./agent.js";
import { SHOTS_DIR, SessionError, checkSession, continueLogin, liveScreen, login, submitCode, tap } from "./auth.js";
import { consoleHtml } from "./console.js";

const app = express();
app.use(express.json());

// Bearer header (Shortcuts) or ?token= (Safari)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? req.query.token;
  if (token !== process.env.AGENT_TOKEN) return res.status(401).json({ error: "unauthorised" });
  next();
});

let busy = false; // one browser at a time
const run = (fn: (req: express.Request) => Promise<any>) => async (req: express.Request, res: express.Response) => {
  if (busy) return res.status(429).json({ message: "Still working on the last request — try again in a minute." });
  busy = true;
  try { res.json(await fn(req)); }
  catch (e: any) {
    const status = e instanceof SessionError ? e.status : "error";
    res.status(e instanceof SessionError && e.status === "needs_code" ? 200 : 500).json({ status, message: `⚠️ ${e.message}` });
  } finally { busy = false; }
};

app.get("/health", (_, res) => res.send("ok"));
app.get("/", (_, res) => res.type("html").send(consoleHtml));

// Setup + login
app.post("/session/check", run(() => checkSession()));
const loginMessage = (status: string) =>
  status === "needs_code" ? "JustPark sent you a code — type it in the box and tap Send code."
  : status === "needs_captcha" ? "JustPark wants a CAPTCHA. Tap the right pictures below, tap Verify, then tap Done."
  : "✅ Logged in.";
app.post("/session/login", run(async () => {
  const r = await login();
  return { ...r, message: loginMessage(r.status) };
}));
app.post("/session/code", run(async (req) => ({ ...(await submitCode(String(req.body.code))), message: "✅ Logged in." })));

// Solving a CAPTCHA from your phone: view the paused browser, tap it, then continue
app.get("/session/screen", async (_, res) => {
  try { res.type("jpeg").send(await liveScreen()); }
  catch (e: any) { res.status(404).send(e.message); }
});
app.post("/session/tap", async (req, res) => {
  try { await tap(Number(req.body.x), Number(req.body.y)); res.json({ ok: true }); }
  catch (e: any) { res.status(404).json({ message: `⚠️ ${e.message}` }); }
});
app.post("/session/continue", run(async () => {
  const r = await continueLogin();
  return { ...r, message: loginMessage(r.status) };
}));

// Booking
app.post("/plan", run((req) => plan(req.body.prompt)));
app.post("/book", run((req) => confirm(req.body.planId, String(req.body.option))));

// Screenshots
app.get("/shots", (_, res) => res.json(fs.readdirSync(SHOTS_DIR).sort().reverse()));
app.get("/shots/latest", (_, res) => {
  const f = fs.readdirSync(SHOTS_DIR).sort().pop();
  f ? res.sendFile(path.resolve(SHOTS_DIR, f)) : res.status(404).send("No screenshots yet");
});
// Newest screenshot for a step, e.g. /shots/latest/login-submitted
app.get("/shots/latest/:label", (req, res) => {
  const f = fs.readdirSync(SHOTS_DIR).filter((n) => n.endsWith(`-${req.params.label}.png`)).sort().pop();
  f ? res.sendFile(path.resolve(SHOTS_DIR, f)) : res.status(404).send(`No "${req.params.label}" screenshot yet`);
});
app.get("/shots/:file", (req, res) => res.sendFile(path.resolve(SHOTS_DIR, path.basename(req.params.file))));

app.listen(Number(process.env.PORT ?? 3000), () => console.log("JustPark agent up"));
