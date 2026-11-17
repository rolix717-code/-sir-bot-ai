const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";
const TELEGRAM_URL = "https://t.me/SirBotAI_Signals_Bot";
let authToken = sessionStorage.getItem("sirbot_token") || "";
let signedUser = null;
document.addEventListener("DOMContentLoaded", () => {
 const $ = id => document.getElementById(id);
 const authScreen=$("authScreen"), appShell=$("appShell");
 const headers=()=>({ "Content-Type":"application/json", ...(authToken?{Authorization:`Bearer ${authToken}`}:{}) });
 async function request(path, options={}) {
   const res=await fetch(API_BASE+path,{...options,headers:{...headers(),...(options.headers||{})},cache:"no-store"});
   const data=await res.json().catch(()=>({error:"Invalid server response"}));
   if(!res.ok) throw new Error(data.error||data.details||`HTTP ${res.status}`);
   return data;
 }
 function showAuth(tab="login"){
   authScreen.classList.remove("hidden");appShell.classList.add("hidden");
   document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b.dataset.authTab===tab));
   $("loginForm").classList.toggle("hidden",tab!=="login");$("registerForm").classList.toggle("hidden",tab!=="register");
 }
 function showApp(user){
   signedUser=user;authScreen.classList.add("hidden");appShell.classList.remove("hidden");
   document.querySelectorAll(".admin-only").forEach(x=>x.classList.toggle("hidden",user.role!=="admin"));
   $("sidebarStatus").textContent=`Signed in: ${user.name||user.email||"Admin"}`;
   checkBackend();loadMarket();loadIndicators();
   setInterval(checkBackend,30000);setInterval(loadMarket,60000);
 }
 function message(id,text){$(id).textContent=text;}
 document.querySelectorAll("[data-auth-tab]").forEach(b=>b.addEventListener("click",()=>showAuth(b.dataset.authTab)));
 $("loginForm").addEventListener("submit",async e=>{
   e.preventDefault();message("loginMessage","Signing in...");
   try{
     const data=await request("/auth/login",{method:"POST",body:JSON.stringify({username:$("loginUsername").value.trim(),password:$("loginPassword").value})});
     authToken=data.token;sessionStorage.setItem("sirbot_token",authToken);showApp(data.user);
   }catch(err){message("loginMessage",err.message);}
 });
 $("registerForm").addEventListener("submit",async e=>{
   e.preventDefault();message("registerMessage","Submitting registration...");
   try{
     const data=await request("/auth/register",{method:"POST",body:JSON.stringify({name:$("registerName").value,email:$("registerEmail").value,password:$("registerPassword").value})});
     message("registerMessage",data.message||"Registration received. Await admin activation.");$("registerForm").reset();
   }catch(err){message("registerMessage",err.message);}
 });
 $("logoutButton").addEventListener("click",async()=>{
   try{await request("/auth/logout",{method:"POST"});}catch{}
   authToken="";signedUser=null;sessionStorage.removeItem("sirbot_token");showAuth("login");
 });
 async function boot(){
   if(!authToken){showAuth();return;}
   try{const me=await request("/auth/me");showApp(me.user);}
   catch{authToken="";sessionStorage.removeItem("sirbot_token");showAuth();}
 }
 // Navigation
 const pages=document.querySelectorAll(".page"),navItems=document.querySelectorAll(".nav-item"),sidebar=$("sidebar");
 const titles={overview:"Overview",market:"Live Market",intelligence:"AI Intelligence",indicators:"Technical Indicators",risk:"Risk Center",account:"Trading Account",admin:"Admin Users"};
 function openPage(name){
   if(name==="admin"&&signedUser?.role!=="admin")return;
   pages.forEach(p=>p.classList.toggle("active",p.id===`page-${name}`));
   navItems.forEach(n=>n.classList.toggle("active",n.dataset.page===name));
   $("pageTitle").textContent=titles[name]||"Overview";sidebar.classList.remove("open");history.replaceState(null,"",`#${name}`);
   if(name==="admin")loadUsers();
 }
 navItems.forEach(n=>n.addEventListener("click",()=>openPage(n.dataset.page)));
 document.querySelectorAll("[data-open]").forEach(b=>b.addEventListener("click",()=>openPage(b.dataset.open)));
 $("menuBtn").addEventListener("click",()=>sidebar.classList.toggle("open"));
 async function api(path,timeoutMs=30000){
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
   try{return await request(path,{signal:controller.signal});}finally{clearTimeout(timer);}
 }
 async function checkBackend(){try{const d=await api("/health");$("backendStatus").textContent="ONLINE";$("sidebarStatus").textContent="Backend online";$("marketConnection").textContent=d.marketData||d.market_data;$("aiConnection").textContent=d.ai;}catch(e){$("backendStatus").textContent="OFFLINE";$("sidebarStatus").textContent="Connection failed";$("marketConnection").textContent="Unavailable";$("aiConnection").textContent="Unavailable";}}
 async function loadMarket(){
   try{const d=await api("/market-price?timeframe=M5");if(!d.success||!Number.isFinite(Number(d.price)))throw Error("Invalid market price response");
   const p=Number(d.price).toFixed(3);["overviewPrice","mainPrice","marketPrice"].forEach(id=>$(id).textContent=p);
   ["mainBid","mainAsk","mainSpread","marketBid","marketAsk","marketSpread"].forEach(id=>$(id).textContent="—");
   const status=d.fresh?"CONNECTED":"STALE DATA";$("marketStatus").textContent=status;$("marketStatus2").textContent=status;$("marketUpdated").textContent=new Date().toLocaleTimeString();
   $("marketMessage").textContent=d.fresh?`XAUUSD price updated. Candle age: ${d.ageMinutes} minutes.`:"Warning: market data is not fresh.";
   }catch(e){$("marketStatus").textContent="OFFLINE";$("marketStatus2").textContent="OFFLINE";$("marketMessage").textContent="Market connection error: "+e.message;}
 }
 async function loadIndicators(){
   $("indicatorMessage").textContent="Calculating technical indicators...";
   try{const d=await api("/indicators?timeframe=M5"),i=d.indicators;if(!i)throw Error("Indicator data unavailable");
   $("ema20").textContent=Number(i.ema20).toFixed(3);$("ema50").textContent=Number(i.ema50).toFixed(3);
   $("rsi14").textContent=Number(i.rsi).toFixed(2);$("rsiCondition").textContent=i.rsi>=70?"Overbought":i.rsi<=30?"Oversold":"Neutral";
   $("macd").textContent=Number(i.macd?.value).toFixed(3);$("macdCondition").textContent=i.macd?.value>=0?"Positive momentum":"Negative momentum";
   $("atr14").textContent=Number(i.atr).toFixed(3);$("structure").textContent=i.structure?.state||"Unavailable";$("indicatorTrend").textContent=i.trend||"UNKNOWN";
   $("indicatorMessage").textContent="Technical indicators updated.";
   }catch(e){$("indicatorMessage").textContent="Indicator error: "+e.message;}
 }
 async function analyzeMarket(){
   const b=$("analyzeButton");b.disabled=true;b.textContent="ANALYZING XAUUSD...";$("aiStatus").textContent="AI analysis running";$("aiReasoning").textContent="Analyzing M5, M15, H1 and H4 market conditions...";
   try{const d=await api("/analyze-live",60000),a=d.analysis;if(!a)throw Error(d.reason||"AI response unavailable");
   const decision=String(d.signal?.decision||a.decision||"WAIT").toUpperCase();
   $("aiDecision").textContent=decision;$("aiDecision").className="decision-display "+decision.toLowerCase();
   $("overviewDecision").textContent=decision;$("overviewAI").textContent=decision;$("overviewAI").className="decision-display "+decision.toLowerCase();
   $("aiTrend").textContent=a.trend||"UNKNOWN";$("aiConfidence").textContent=`${a.confidence??"—"}%`;$("overviewConfidence").textContent=`${a.confidence??"—"}%`;
   $("overviewTrend").textContent=a.trend||"UNKNOWN";$("aiCandles").textContent=d.candle_count??"—";
   $("aiReasoning").textContent=d.signal?.reason||a.reasoning||"No reasoning provided.";$("overviewReason").textContent=a.reasoning||"No reasoning provided.";
   $("aiWarning").textContent=a.risk_warning||"AI analysis is not a guaranteed trading signal.";$("aiTimestamp").textContent="Last analysis: "+new Date().toLocaleString();
   if(d.market?.M5){const i=d.market.M5;$("ema20").textContent=Number(i.ema20).toFixed(3);$("ema50").textContent=Number(i.ema50).toFixed(3);$("rsi14").textContent=Number(i.rsi).toFixed(2);$("atr14").textContent=Number(i.atr).toFixed(3);$("indicatorTrend").textContent=i.trend||"UNKNOWN";}
   }catch(e){$("aiReasoning").textContent="Analysis failed: "+e.message;}
   finally{b.disabled=false;b.textContent="✦ ANALYZE XAUUSD";}
 }
 $("refreshMarket").addEventListener("click",loadMarket);$("refreshIndicators").addEventListener("click",loadIndicators);$("analyzeButton").addEventListener("click",analyzeMarket);
 $("riskPct").addEventListener("input",e=>$("riskValue").textContent=e.target.value+"%");
 async function loadUsers(){
   $("usersTable").innerHTML='<tr><td colspan="5">Loading users...</td></tr>';
   try{const d=await request("/admin/users");$("usersTable").innerHTML="";
     for(const u of d.users){const tr=document.createElement("tr");const cells=[u.name,u.email,u.status,u.created_at?new Date(u.created_at).toLocaleString():"—"];
       cells.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});
       const td=document.createElement("td");
       if(u.role!=="admin"){const action=u.status==="active"?"disabled":"active";const btn=document.createElement("button");btn.className="table-action "+(action==="active"?"activate":"disable");btn.textContent=action==="active"?"ACTIVATE":"DISABLE";btn.addEventListener("click",()=>changeStatus(u.id,action));td.appendChild(btn);}
       tr.appendChild(td);$("usersTable").appendChild(tr);
     }
     if(!d.users.length)$("usersTable").innerHTML='<tr><td colspan="5">No registrations yet.</td></tr>';
   }catch(e){$("usersTable").innerHTML=`<tr><td colspan="5">${e.message}</td></tr>`;}
 }
 async function changeStatus(id,status){try{await request(`/admin/users/${encodeURIComponent(id)}/status`,{method:"POST",body:JSON.stringify({status})});message("adminMessage",`User status changed to ${status}.`);loadUsers();}catch(e){message("adminMessage",e.message);}}
 $("refreshUsers").addEventListener("click",loadUsers);
 boot();
});
