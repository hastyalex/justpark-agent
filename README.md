# JustPark booking agent — iPhone-only edition

No computer needed for setup or use. Everything runs on Railway; you drive it from Safari, the Claude app, and Shortcuts.

## Setup (≈1.5 hrs, all on iPhone)

### 1. Prepare JustPark (Safari, 10 min)
- Make sure you can log in with **email + password**. If you normally use Sign in with Apple/Google, use "Forgot password" to set one.
- Check a **saved card** and a **default vehicle** exist on your account.
- Do one search with dates and copy the results URL into Notes. Find the parameter names for arrival and departure time — you'll need them in step 3.

### 2. Get the code onto GitHub (15 min)
1. In Safari, go to github.com → **New repository** → private, name it `justpark-agent`, tick "Add a README".
2. In the repo: **Add file → Upload files** → pick `justpark-agent.zip` from Files → Commit.
3. Open the Claude app → **Code** tab → connect GitHub and pick that repo. Prompt:
   > Unzip justpark-agent.zip into the repo root (flatten the top folder), delete the zip, and commit to main.

### 3. Deploy on Railway (Safari, 15 min)
1. railway.com → **New Project → Deploy from GitHub repo** → `justpark-agent`. It builds from the Dockerfile.
2. Service → **Settings → Volumes → Add volume**, mount path `/data`. This keeps your login and screenshots across redeploys.
3. **Variables**: add everything in `.env.example`. Set `JP_PARAM_START`/`JP_PARAM_END` to the names from step 1. Keep `DRY_RUN=true`.
4. **Settings → Networking → Generate domain**.

### 4. Log in (Safari, 5 min)
1. Open `https://YOUR-APP.up.railway.app/?token=YOUR_TOKEN`. Share → **Add to Home Screen** for one-tap access.
2. Tap **Log in**. If JustPark sends a verification code, type it in and tap **Send code**.
3. Tap **Check session** — the screenshot should show your JustPark dashboard.
4. If it shows a CAPTCHA, wait an hour and retry; datacentre IPs sometimes get challenged on first login.

### 5. Dry runs (20–30 min)
1. Type a request and tap **Find parking**. You get up to 5 options; tap one to dry-run the booking.
2. Check the screenshot after each step — it should end on the checkout page with the right total.
3. If something breaks, the error names a screenshot. Open the Code tab in the Claude app, attach the screenshot, and say e.g. *"The search box placeholder is 'Where are you going?' — fix the selector in src/justpark.ts"*. Railway redeploys automatically on push.
4. Try 3–4 different prompts until results are consistently right.

### 6. Build the Shortcut (15 min)
Shortcuts app → new shortcut "Park":
1. **Dictate Text**
2. **Get Contents of URL** — `https://YOUR-APP.up.railway.app/plan`, POST, header `Authorization: Bearer YOUR_TOKEN`, JSON body `prompt` = Dictated Text
3. **Get Dictionary Value** `message` → **Show Result**
4. **Ask for Input** (Number) "Which option?"
5. **Get Contents of URL** — `/book`, POST, same header, JSON body `planId` = (Dictionary Value `planId` from step 2), `option` = Provided Input
6. **Get Dictionary Value** `message` → **Show Notification**

Now "Hey Siri, Park" works.

**Aria alternative:** in Make.com, route parking requests to `/plan` and store `planId` in Sheets. Route a reply of 1–5 to `/book` and a reply of 4–8 digits to `/session/code`, so you can complete logins over WhatsApp too.

### 7. Go live
Do one dry run through the Shortcut, then set `DRY_RUN=false` in Railway and make one cheap real booking.

## Upkeep
- Expired sessions re-login automatically. If JustPark wants a code, you'll get a "send me the code" message.
- When JustPark changes its site, fix it via the Claude app's Code tab plus a screenshot — no laptop needed.

## Safety rails
Dry run by default · hard price cap · aborts if the checkout total drifts >10% from the quote · 3-D Secure challenges return a link to finish yourself · one booking at a time · everything behind your token.
Your JustPark password sits in Railway env vars, so use a unique password for it. Automating a consumer site may breach its terms; keep volumes personal-scale.
