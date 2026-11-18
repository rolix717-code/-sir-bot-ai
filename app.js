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
     message("registerMessage",data.message||"Account created. You can now sign in.");$("registerForm").reset();
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
 const titles={overview:"Overview",market:"Live Market",intelligence:"AI Intelligence",vision:"AI Vision Scanner",indicators:"Technical Indicators",risk:"Risk Center",account:"Trading Account",admin:"Admin Users"};
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
 async function checkBackend(){try{const d=await api("/health");$("backendStatus").textContent="ONLINE";$("sidebarStatus").textContent="Backend online";$("marketConnection").textContent=d.marketData||d.market_data;$("aiConnection").textContent=d.ai;}catch(e){$("backendStatus").textContent="OFFLINE";$("sidebarStatus").textContent="Connection failed";$("marketConnection").textContent="Unavailable";$("aiConnection").textContent="Unavailable";} }
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
   const b=$("analyzeButton"),strategy=$("strategyMode").value; b.disabled=true;b.textContent="ANALYZING XAUUSD...";$("aiStatus").textContent="AI analysis running";$("aiReasoning").textContent=`Running ${strategy} profile using the available M5/M15/H1/H4 feed...`;
   try{const d=await api("/analyze-live?strategy="+encodeURIComponent(strategy),60000),a=d.analysis;if(!a)throw Error(d.reason||"AI response unavailable");
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
 function syncStrategySelectors(source){
   const value=source?.value||$("strategyMode")?.value||"NORMAL";
   if($("strategyMode"))$("strategyMode").value=value;
   if($("strategyModeOverview"))$("strategyModeOverview").value=value;
   if($("strategyDescription"))$("strategyDescription").textContent=value==="AGGRESSIVE_SCALPER"?"Aggressive AI Scalper: faster M5 momentum/breakout analysis with M15 confirmation and H1 context.":"Normal AI Trader: selective setups using M5 entry timing with M15/H1/H4 confirmation.";
 }
 if($("strategyMode"))$("strategyMode").addEventListener("change",e=>syncStrategySelectors(e.target));
 if($("strategyModeOverview"))$("strategyModeOverview").addEventListener("change",e=>syncStrategySelectors(e.target));
 if($("openSelectedStrategy"))$("openSelectedStrategy").addEventListener("click",()=>{syncStrategySelectors($("strategyModeOverview"));openPage("intelligence");});
 $("refreshMarket").addEventListener("click",loadMarket);$("refreshIndicators").addEventListener("click",loadIndicators);$("analyzeButton").addEventListener("click",analyzeMarket);
 $("riskPct").addEventListener("input",e=>$("riskValue").textContent=e.target.value+"%");


 // MT5 account form is intentionally preview-only until the authenticated VPS vault is deployed.
 const connectAccountButton=$("connectAccountButton");
 if(connectAccountButton)connectAccountButton.addEventListener("click",()=>{
   const broker=$("accountBroker").value,login=$("accountLogin").value.trim(),server=$("accountServer").value.trim(),password=$("accountPassword").value;
   if(!broker||!login||!server||!password){message("accountConnectMessage","Choose a broker and complete all fields to preview the connection flow.");return;}
   $("accountPassword").value="";
   message("accountConnectMessage","Preview only: no credentials were sent or saved. The secure Cloudflare-to-VPS account connection must be completed before real MT5 details can be accepted.");
 });

 // AI Vision Scanner: screenshot-only analysis; no live execution.
 const visionFile=$("visionFile"), visionPreview=$("visionPreview"), visionAnalyze=$("visionAnalyze");
 let visionObjectUrl="";
 visionFile.addEventListener("change",()=>{
   const file=visionFile.files?.[0];
   $("visionResult").classList.add("hidden");
   if(visionObjectUrl)URL.revokeObjectURL(visionObjectUrl);
   visionObjectUrl="";
   if(!file){visionPreview.classList.add("hidden");visionAnalyze.disabled=true;return;}
   if(!["image/png","image/jpeg","image/webp"].includes(file.type)||file.size>5*1024*1024){
     message("visionMessage","Choose a PNG, JPG or WEBP image no larger than 5 MB.");
     visionFile.value="";visionPreview.classList.add("hidden");visionAnalyze.disabled=true;return;
   }
   visionObjectUrl=URL.createObjectURL(file);visionPreview.src=visionObjectUrl;
   visionPreview.classList.remove("hidden");visionAnalyze.disabled=false;
   message("visionMessage",`Selected: ${file.name}. Ready to analyze.`);
 });
 $("visionClear").addEventListener("click",()=>{
   visionFile.value="";if(visionObjectUrl)URL.revokeObjectURL(visionObjectUrl);
   visionObjectUrl="";visionPreview.removeAttribute("src");visionPreview.classList.add("hidden");
   visionAnalyze.disabled=true;$("visionResult").classList.add("hidden");
   message("visionMessage","Choose a chart screenshot to begin.");
 });
 visionAnalyze.addEventListener("click",async()=>{
   const file=visionFile.files?.[0];if(!file)return;
   visionAnalyze.disabled=true;visionAnalyze.textContent="ANALYZING IMAGE...";
   message("visionMessage","Uploading screenshot securely for AI visual analysis...");
   $("visionResult").classList.add("hidden");
   try{
     const form=new FormData();form.append("chart",file);form.append("timeframe",$("visionTimeframe").value);
     const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
     let res;
     try{res=await fetch(API_BASE+"/analyze-image",{method:"POST",headers:authToken?{Authorization:`Bearer ${authToken}`}:{},body:form,signal:controller.signal,cache:"no-store"});}
     finally{clearTimeout(timer);}
     const data=await res.json().catch(()=>({error:"Invalid server response"}));
     if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
     const a=data.analysis||{};
     $("visionDecision").textContent=a.decision||"WAIT";
     $("visionDecision").className="decision-display "+String(a.decision||"wait").toLowerCase();
     $("visionTrend").textContent=a.trend||"—";$("visionConfidence").textContent=`${a.confidence??"—"}%`;
     $("visionStructure").textContent=a.market_structure||"—";
     const displayPrice=v=>v===null||v===undefined||v===""?"Not readable":Number.isFinite(Number(v))?Number(v).toFixed(3):"Not readable";
     $("visionEntry").textContent=displayPrice(a.entry);$("visionSL").textContent=displayPrice(a.stop_loss);
     $("visionTP1").textContent=displayPrice(a.take_profit_1);$("visionTP2").textContent=displayPrice(a.take_profit_2);
     $("visionTP3").textContent=displayPrice(a.take_profit_3);$("visionSupport").textContent=displayPrice(a.support);
     $("visionResistance").textContent=displayPrice(a.resistance);
     $("visionReasoning").textContent=a.reasoning||"No reasoning provided.";
     $("visionWarning").textContent=a.risk_warning||"Screenshot-only analysis. Verify all levels against live market data.";
     $("visionResult").classList.remove("hidden");
     message("visionMessage","Analysis complete. This result is based only on the uploaded screenshot.");
   }catch(err){message("visionMessage","Analysis failed: "+(err.name==="AbortError"?"Request timed out. Try a smaller image.":err.message));}
   finally{visionAnalyze.disabled=!visionFile.files?.[0];visionAnalyze.textContent="✦ ANALYZE CHART IMAGE";}
 });


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
 document.querySelectorAll('[data-page="admin"]').forEach(btn=>btn.addEventListener("click",loadUsers));
 $("refreshUsers").addEventListener("click",loadUsers);
 boot();
});
