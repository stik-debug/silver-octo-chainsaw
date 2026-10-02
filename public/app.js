
const $=s=>document.querySelector(s), esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let markers=[];let T=JSON.parse(localStorage.getItem("mp")||"null"), pos=null, map, layer;
const mk=(lng,lat,label,color)=>{const e=document.createElement("div");e.style.cssText=`width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 3px 8px #0007`;return new maplibregl.Marker({element:e}).setLngLat([lng,lat]).setPopup(new maplibregl.Popup().setText(label)).addTo(map)};
const toast=m=>{const d=document.createElement("div");d.textContent=m;d.style.cssText="position:fixed;bottom:16px;right:16px;background:#0b5d3b;color:#fff;padding:10px 14px;border-radius:10px";document.body.appendChild(d);setTimeout(()=>d.remove(),4000)};
let es,cur="find";function live(){if(!T)return;es?.close();es=new EventSource("/api/stream?token="+encodeURIComponent(T.accessToken));es.onmessage=e=>{toast(JSON.parse(e.data).body);if(cur=="bk"||cur=="nt")show(cur)};es.onerror=()=>{es.close();setTimeout(live,5000)}}
const save=()=>localStorage.setItem("mp",JSON.stringify(T));
async function api(p,o={}){const r=await fetch("/api"+p,{method:o.method||(o.body?"POST":"GET"),headers:{"Content-Type":"application/json",...(T?{Authorization:"Bearer "+T.accessToken}:{})},body:o.body?JSON.stringify(o.body):undefined});
 if(r.status===401&&T?.refreshToken&&!o.retry){const f=await fetch("/api/auth/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({refreshToken:T.refreshToken})});
  if(f.ok){T.accessToken=(await f.json()).accessToken;save();return api(p,{...o,retry:1})}T=null;save();render();}
 const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"Request failed");return j}
const say=m=>alert(m);const wrap=f=>async(...a)=>{try{await f(...a)}catch(e){say(e.message)}};

function loginView(){$("#app").innerHTML=`<div class="card"><h3>Sign in or register</h3>
 <input id="ph" placeholder="2547XXXXXXXX"><button id="go">Send code</button>
 <div id="step2" hidden><input id="code" placeholder="6-digit code"><input id="nm" placeholder="Your name (new accounts)">
 <label><input type="checkbox" id="tc"> I accept the Terms</label><br><label><input type="checkbox" id="pc"> I consent to processing of my personal data (Privacy Policy)</label><br>
 <input id="totp" placeholder="Authenticator code (admins)"><button id="vf">Verify</button></div></div>`;
 $("#go").onclick=wrap(async()=>{await api("/auth/request-otp",{body:{phone:$("#ph").value}});$("#step2").hidden=false});
 $("#vf").onclick=wrap(async()=>{const r=await api("/auth/verify-otp",{body:{phone:$("#ph").value,code:$("#code").value,name:$("#nm").value||undefined,acceptTerms:$("#tc").checked,privacyConsent:$("#pc").checked,totp:$("#totp").value||undefined}});
  if(r.mfaEnrolmentRequired){say("Admin MFA enrolment required: call /api/account/mfa/setup then /confirm with this token.");return}T=r;save();render()})}

function shell(){$("#who").innerHTML=`${esc(T.user.name)} <button class="s" id="out">Log out</button>`;$("#out").onclick=wrap(async()=>{await api("/auth/logout",{body:{refreshToken:T.refreshToken}});es?.close();T=null;save();render()});
 $("#app").innerHTML=`<nav><button data-v="find">Find a pro</button><button data-v="bk">My bookings</button><button data-v="nt">Notifications</button><button data-v="pv">Become a provider</button></nav><div id="view"></div>`;
 document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>show(b.dataset.v));show("find");live()}
const ACT={};const show=v=>{cur=v;({find:findView,bk:bookingsView,nt:notifView,pv:providerView})[v]()};

async function findView(){const cats=await api("/categories");
 $("#view").innerHTML=`<div class="card"><div class="row"><select id="cat">${cats.map(c=>`<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join("")}</select>
 <select id="rad"><option>2</option><option selected>5</option><option>10</option></select> km <button id="loc">Use my location & search</button></div>
 <p class="muted" id="msg">${cats.length?"Allow location access to search near you.":"No service categories configured yet."}</p><div id="map"></div></div><div id="res"></div>`;
 map=new maplibregl.Map({container:"map",style:"https://tiles.openfreemap.org/styles/liberty",center:[36.817,-1.286],zoom:11,pitch:60,bearing:-17});map.addControl(new maplibregl.NavigationControl());markers=[];
 $("#loc").onclick=()=>navigator.geolocation?navigator.geolocation.getCurrentPosition(wrap(async p=>{pos={lat:p.coords.latitude,lng:p.coords.longitude};await search()}),()=>say("Location is off. Enable it in your browser to search nearby."),{enableHighAccuracy:true}):say("Geolocation isn't supported.")}
const search=wrap(async()=>{const r=await api(`/providers/search?category=${$("#cat").value}&lat=${pos.lat}&lng=${pos.lng}&radiusKm=${$("#rad").value}`);
 map.easeTo({center:[pos.lng,pos.lat],zoom:14,pitch:60,duration:1500});markers.forEach(m=>m.remove());markers=[mk(pos.lng,pos.lat,"You","#1d4ed8")];
 $("#msg").textContent=r.message||"";r.providers.forEach(p=>markers.push(mk(p.approx.lng,p.approx.lat,p.name+" (approx. area)","#0b5d3b")));$("#res").innerHTML=r.providers.map(p=>`<div class="card"><b>${esc(p.name)}</b> ✔ Verified · ${p.distanceKm} km<br>${p.rating?`★ ${p.rating} (${p.reviewCount})`:"No reviews yet."}
  <p>${esc(p.bio)}</p><textarea id="d${p.id}" placeholder="Describe the job" rows="2" style="width:100%"></textarea><button data-id="${p.id}">Request service</button></div>`).join("");
 document.querySelectorAll("#res button").forEach(b=>b.onclick=wrap(async()=>{await api("/bookings",{body:{providerId:b.dataset.id,categorySlug:$("#cat").value,description:$("#d"+b.dataset.id).value,lat:pos.lat,lng:pos.lng}});say("Request sent. The provider has been notified.")}))});

async function bookingsView(){const r=await api("/bookings");const me=T.user.id;
 $("#view").innerHTML=r.bookings.length?r.bookings.map(b=>{const mine=b.customerId===me;const A=[];
  const add=(l,fn)=>A.push([l,fn]);const tr=to=>()=>api(`/bookings/${b.id}/transition`,{body:{to}});
  if(!mine){if(b.status=="REQUESTED"){add("Accept",tr("ACCEPTED"));add("Decline",tr("DECLINED"))}
   if(b.status=="ACCEPTED")add("Send quote",()=>api(`/bookings/${b.id}/quote`,{body:{amountKes:+prompt("Quote (KES)")}}));
   if(b.status=="SCHEDULED")add("I've arrived",tr("PROVIDER_ARRIVED"));if(b.status=="PROVIDER_ARRIVED")add("Start work",tr("IN_PROGRESS"));if(b.status=="IN_PROGRESS")add("Mark completed",tr("COMPLETED"))}
  else{if(b.status=="QUOTED")add(`Accept KES ${b.quoteKes}`,tr("QUOTE_ACCEPTED"));
   if(b.status=="QUOTE_ACCEPTED")add("Pay with M-Pesa",async()=>{await api(`/payments/bookings/${b.id}/pay`,{body:{phone:prompt("M-Pesa number 2547XXXXXXXX")}});say("Check your phone and enter your M-Pesa PIN.")});
   if(b.status=="PAYMENT_PENDING")b.payments?.[0]&&add("Check payment status",async()=>{const r=await api(`/payments/${b.payments[0].id}/check`,{body:{}});say(r.message||"Payment: "+r.status);});
   if(b.status=="COMPLETED"){add("Confirm completion",tr("CONFIRMED"));add("Dispute",()=>api("/account/disputes",{body:{bookingId:b.id,reason:prompt("What went wrong?")}}))}
   if(b.status=="CONFIRMED")add("Leave review",()=>api(`/bookings/${b.id}/review`,{body:{rating:+prompt("Rating 1-5"),text:prompt("Comment")||undefined}}))}
  ACT[b.id]=A;return `<div class="card"><b>${esc(b.status.replace(/_/g," "))}</b> · ${esc(b.description)}${b.quoteKes?` · KES ${b.quoteKes}`:""}<br>${A.map((a,i)=>`<button data-b="${b.id}" data-i="${i}">${esc(a[0])}</button>`).join("")}
   <button class="s" data-chat="${b.id}">Messages</button></div>`}).join(""):`<div class="card muted">${esc(r.message)}</div>`;
 
 // re-bind: rebuild actions per booking by re-running logic on click
 document.querySelectorAll("[data-chat]").forEach(b=>b.onclick=wrap(async()=>{const id=b.dataset.chat;const m=await api(`/bookings/${id}/messages`);const t=prompt((m.messages.map(x=>(x.senderId==me?"Me: ":"Them: ")+x.body).join("\n")||m.message)+"\n\nNew message (blank to close):");if(t)await api(`/bookings/${id}/messages`,{body:{body:t}})}));
 document.querySelectorAll("[data-i]").forEach(btn=>btn.onclick=wrap(async()=>{const bk=r.bookings.find(x=>x.id==btn.dataset.b);await ACT[btn.dataset.b][+btn.dataset.i][1]();bookingsView()}))}

async function notifView(){const r=await api("/notifications");$("#view").innerHTML=r.notifications.length?r.notifications.map(n=>`<div class="card">${esc(n.body)}<div class="muted">${new Date(n.createdAt).toLocaleString()}</div></div>`).join(""):`<div class="card muted">${esc(r.message)}</div>`}

function providerView(){$("#view").innerHTML=`<div class="card"><h3>Provider profile</h3><input id="ln" placeholder="Full legal name"><input id="ex" type="number" placeholder="Years of experience">
 <input id="cs" placeholder="Service slugs, comma separated (e.g. plumbing,cleaning)"><input id="rd" type="number" placeholder="Service radius km"><input id="pp" placeholder="M-Pesa payout number 2547XXXXXXXX"><textarea id="bio" placeholder="About you"></textarea>
 <button id="sv">Save profile (uses your current location as base)</button></div>
 <div class="card"><h3>Verification</h3><select id="dk"><option>NATIONAL_ID</option><option>PASSPORT</option><option>GOOD_CONDUCT</option><option>TRADE_CERT</option></select><input type="file" id="fl" accept="image/jpeg,image/png,application/pdf"><button id="up">Upload document</button>
 <button id="sb">Submit for verification</button><br><button class="s" id="av">Go available</button> <button class="s" id="er">View earnings</button> <button class="s" id="po">Request payout</button></div>`;
 $("#sv").onclick=wrap(()=>new Promise((ok,no)=>navigator.geolocation.getCurrentPosition(wrap(async p=>{await api("/providers/me",{body:{legalName:$("#ln").value,bio:$("#bio").value||undefined,experienceYears:+$("#ex").value,categorySlugs:$("#cs").value.split(",").map(s=>s.trim()),lat:p.coords.latitude,lng:p.coords.longitude,serviceRadiusKm:+$("#rd").value,payoutPhone:$("#pp").value}});say("Profile saved. Log in again to refresh your role.");ok()}),()=>{say("Enable location to set your service base.");no()})));
 $("#up").onclick=wrap(async()=>{const f=$("#fl").files[0];if(!f)throw new Error("Choose a file");const p=await api("/uploads/presign",{body:{contentType:f.type}});const fd=new FormData();Object.entries(p.fields).forEach(([k,v])=>fd.append(k,v));fd.append("file",f);const r=await fetch(p.url,{method:"POST",body:fd});if(!r.ok)throw new Error("Upload failed");
  await api("/providers/me/documents",{body:{kind:$("#dk").value,storageKey:p.key}});say("Document uploaded.")});
 $("#sb").onclick=wrap(async()=>{await api("/providers/me/submit-verification",{body:{}});say("Submitted. We'll notify you after review.")});
 $("#av").onclick=wrap(async()=>{await api("/providers/me/availability",{method:"PATCH",body:{available:true}});say("You're now available.")});
 $("#er").onclick=wrap(async()=>{const e=await api("/payments/earnings");say(e.message||`Total KES ${e.totalEarnedKes}\nPending ${e.pendingKes}\nAvailable ${e.availableKes}\nPaid out ${e.paidOutKes}`)});
 $("#po").onclick=wrap(async()=>{const r=await api("/payouts/request",{body:{}});say(`Payout of KES ${r.amountKes} started.`)})}
function render(){T?(shell()):(($("#who").innerHTML=""),loginView())}render();
