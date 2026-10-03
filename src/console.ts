// A tiny phone-friendly control panel, served at /?token=YOUR_TOKEN. Bookmark it to your Home Screen.
export const consoleHtml = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><title>Parking agent</title>
<style>
:root{--bg:#fff;--fg:#111;--mut:#666;--card:#f3f3f5;--acc:#0a7cff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#eee;--mut:#999;--card:#1c1c1e}}
*{box-sizing:border-box}body{margin:0;padding:calc(env(safe-area-inset-top) + 16px) 16px 40px;font:16px -apple-system,system-ui;background:var(--bg);color:var(--fg)}
h1{font-size:22px;margin:0 0 12px}h2{font-size:15px;color:var(--mut);margin:24px 0 8px;text-transform:uppercase;letter-spacing:.04em}
textarea,input{width:100%;font:inherit;padding:12px;border-radius:12px;border:1px solid #8884;background:var(--card);color:var(--fg)}
button{font:inherit;font-weight:600;padding:12px 16px;border:0;border-radius:12px;background:var(--acc);color:#fff;margin:8px 8px 0 0}
button.alt{background:var(--card);color:var(--fg)}pre{white-space:pre-wrap;background:var(--card);padding:12px;border-radius:12px;font:14px ui-monospace,monospace}
img{max-width:100%;border-radius:12px;margin-top:8px;border:1px solid #8884}
</style></head><body>
<h1>🅿️ Parking agent</h1>
<textarea id="p" rows="3" placeholder="Twickenham Saturday, 3pm kick-off, under £20"></textarea>
<button onclick="go('/plan',{prompt:p.value})">Find parking</button>
<div id="opts"></div>
<pre id="out">Ready.</pre>
<h2>Login</h2>
<button class="alt" onclick="go('/session/check')">Check session</button>
<button class="alt" onclick="go('/session/login')">Log in</button>
<input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Verification code" style="margin-top:8px">
<button class="alt" onclick="go('/session/code',{code:code.value})">Send code</button>
<h2>Latest screenshot</h2>
<button class="alt" onclick="loadShot()">Refresh</button><img id="shot">
<script>
const T=new URLSearchParams(location.search).get('token');let planId=null;
async function go(path,body){out.textContent='Working… (searches take ~30–60s)';opts.innerHTML='';
 try{const r=await fetch(path+'?token='+T,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
 const j=await r.json();out.textContent=j.message||JSON.stringify(j,null,2);
 if(j.planId){planId=j.planId;j.options.forEach(o=>{const b=document.createElement('button');b.textContent='Book '+o.id+' · £'+o.priceGbp.toFixed(2);b.onclick=()=>go('/book',{planId,option:o.id});opts.appendChild(b)})}}
 catch(e){out.textContent='⚠️ '+e.message}loadShot()}
function loadShot(){shot.src='/shots/latest?token='+T+'&t='+Date.now()}
loadShot();
</script></body></html>`;
