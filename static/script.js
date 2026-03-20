// ─── State ────────────────────────────────────────
let curChat=null,allChats=[],ttsOn=false,recording=false,recognition=null,pendingFiles=[],pendingFolder='';
let curUser=null,isGuest=false,authMode='login',theme='dark',googleClientId='';
let googleInitDone=false,thinkingEnabled=false,researchEnabled=false,guestAuthMode='register';
let deepResearchDepth='standard';
let onboardingChecked=false;
const runningStreams=new Map();
const artifactStore=[];
const artifactIndex=new Map();
const mindMapStore=new Map();
const chatTodoStore=new Map();
const uploadedHistory=[];
const workspaceFileCache=new Map();
let canvasTabs=[];
let activeCanvasTabId=null;
const _thinkPhrases=['Thinking this through...','Working on it...','Pulling ideas together...','Reasoning carefully...','Analyzing your request...','Finding the best approach...'];
let _thinkInterval=null;
const ONB_SKIP_KEY='nexus_onboarding_skipped';
const ONB_NO_REMIND_KEY='nexus_onboarding_no_remind';
const ONB_DISMISS_KEY='nexus_onboarding_reminder_dismissed';
const CALENDAR_STATE_KEY='nexus_calendar_state_v1';
const HOME_WIDGET_CACHE_KEY='nexus_home_widgets_cache_v1';
const CHAT_CACHE_KEY='nexus_recent_chats_v1';
let calendarToken='';
let calendarTokenClient=null;
let calendarEvents=[];
let homeWidgetRefreshTimer=null;
let homeWidgetRefreshInFlight=false;

function startThinkingPhrases(el){
  let i=0;
  if(_thinkInterval)clearInterval(_thinkInterval);
  _thinkInterval=setInterval(()=>{
    if(!el||!el.isConnected){clearInterval(_thinkInterval);_thinkInterval=null;return;}
    i=(i+1)%_thinkPhrases.length;
    el.textContent=' '+_thinkPhrases[i];
  },2200);
}

function stopThinkingPhrases(){
  if(_thinkInterval){clearInterval(_thinkInterval);_thinkInterval=null;}
}

function isChatRunning(chatId){
  return !!(chatId&&runningStreams.has(chatId));
}

function updateComposerBusyUI(){
  const busy=isChatRunning(curChat);
  const btnSend=document.getElementById('btnSend');
  const btnStop=document.getElementById('btnStop');
  if(btnSend)btnSend.style.display=busy?'none':'';
  if(btnStop)btnStop.style.display=busy?'':'none';
}

function setChatRunning(chatId,state,meta={}){
  if(!chatId)return;
  if(state)runningStreams.set(chatId,meta);
  else runningStreams.delete(chatId);
  renderChatList(document.getElementById('chatSearch')?.value||'');
  updateComposerBusyUI();
}

function stopStreaming(){
  if(!curChat)return;
  const run=runningStreams.get(curChat);
  if(run?.type==='research'){
    cancelCurrentResearch();
  }else if(run?.controller){
    run.controller.abort();
  }
}

function editMsg(btn){
  const msgEl=btn.closest('.msg');
  const text=msgEl.dataset.text||'';
  const input=document.getElementById('msgInput');
  input.value=text;autoResize(input);
  const next=msgEl.nextElementSibling;
  if(next&&(next.classList.contains('kairo')||next.classList.contains('msg')))next.remove();
  msgEl.remove();
  input.focus();
}

function retryMsg(btn){
  if(isChatRunning(curChat))return;
  const msgEl=btn.closest('.msg');
  let prev=msgEl.previousElementSibling;
  while(prev&&!prev.classList.contains('user')){prev=prev.previousElementSibling;}
  if(!prev){showToast('No previous message to retry.','info');return;}
  const text=prev.dataset.text||'';
  if(!text){showToast('Nothing to retry.','info');return;}
  msgEl.remove();
  document.getElementById('msgInput').value=text;
  sendMessage();
}

// ─── Auto Resume ──────────────────────────────────
async function tryAutoResume(){
  // Try to resume an authenticated session using a stored remember token
  const savedUid=localStorage.getItem('nexus_uid');
  const savedToken=localStorage.getItem('nexus_remember');
  if(savedUid && savedToken){
    try{
      const r=await fetch('/api/auth/resume',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user_id:savedUid,remember_token:savedToken})});
      const d=await r.json();
      if(d.authenticated){
        curUser=d.user; curUser.plan=d.user.plan||'free';
        theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
        applyTheme(false);
        onboardingChecked=!!d.onboarding_complete;
        return true;
      }
    }catch{}
  }
  // Try to resume a guest session using stored guest_id
  const savedGid=localStorage.getItem('nexus_guest_id');
  if(savedGid){
    try{
      const r=await fetch('/api/auth/guest',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({guest_id:savedGid})});
      const d=await r.json();
      if(d.ok){
        isGuest=true; curUser={name:'Guest',email:'',plan:'guest'};
        return true;
      }
    }catch{}
  }
  return false;
}

// Wrap API fetch: on 401, try auto-resume once and retry
async function apiFetch(url, opts={}){
  let r=await fetch(url,opts);
  if(r.status===401 && !apiFetch._resuming){
    apiFetch._resuming=true;
    const ok=await tryAutoResume();
    apiFetch._resuming=false;
    if(ok) r=await fetch(url,opts);
  }
  return r;
}

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded',async()=>{
  if(!localStorage.getItem('nexus_theme_override')){
    theme=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
    applyTheme(false);
  }
  const r=await fetch('/api/auth/me');const d=await r.json();
  if(d.authenticated){
    curUser=d.user; curUser.plan=d.user.plan||'free';
    theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
    applyTheme(false);
    onboardingChecked=!!d.onboarding_complete;
    showApp();
  } else if(d.guest){
    isGuest=true; curUser={name:'Guest',email:'',plan:'guest'};
    showApp();
  } else {
    // Session lost — try to resume from localStorage
    const resumed = await tryAutoResume();
    if(resumed){
      showApp();
    } else {
      try{const o=await fetch('/api/oauth-config').then(r=>r.json());
        googleClientId=o.google_client_id||'';
      }catch{}
      document.getElementById('loginPage').style.display='flex';
      initGoogleAuthUI();
    }
  }
  initDropzone();
  refreshModeMenuUI();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change',e=>{
    if(!localStorage.getItem('nexus_theme_override')){
      theme=e.matches?'light':'dark'; applyTheme(true);
    }
  });
});

function initGoogleAuthUI(retries=0){
  const wrap=document.getElementById('googleButton');
  const help=document.getElementById('googleHelp');
  if(!wrap||!help)return;
  if(!googleClientId){
    help.textContent='Google sign-in is missing a client ID.';
    return;
  }
  if(!window.google?.accounts?.id){
    if(retries<20){
      window.setTimeout(()=>initGoogleAuthUI(retries+1),250);
    }else{
      help.textContent='Google sign-in failed to load. Refresh the page.';
    }
    return;
  }
  if(!googleInitDone){
    google.accounts.id.initialize({client_id:googleClientId,callback:handleGoogleCred});
    googleInitDone=true;
  }
  wrap.innerHTML='';
  google.accounts.id.renderButton(wrap,{theme:'outline',size:'large',shape:'pill',text:'signin_with',width:250,logo_alignment:'left'});
  help.textContent='Use your Google account to sign in.';
}

function applyTheme(animated=true){
  if(animated){
    document.documentElement.style.setProperty('--theme-transition','background-color .5s ease, border-color .5s ease, color .4s ease');
  } else {
    document.documentElement.style.setProperty('--theme-transition','none');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.documentElement.style.setProperty('--theme-transition','background-color .5s ease, border-color .5s ease, color .4s ease');
    }));
  }
  document.body.classList.toggle('light',theme==='light');
  const btn=document.getElementById('btnTheme');
  if(btn)btn.textContent=theme==='light'?'☀️':'🌙';
  const dark=document.getElementById('themeBtn_dark');
  const light=document.getElementById('themeBtn_light');
  if(dark&&light){
    const activeStyle='background:var(--bg-surface);color:var(--text-primary);border-radius:5px;';
    const inactiveStyle='background:transparent;color:var(--text-muted);';
    dark.style.cssText=(theme==='dark'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
    light.style.cssText=(theme==='light'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
  }
  initMermaidTheme();
}

function toggleTheme(){
  theme=theme==='light'?'dark':'light';
  localStorage.setItem('nexus_theme_override','1');
  applyTheme(true);
  fetch('/api/auth/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme})});
}

// ─── Custom Dialog Engine ────────────────────────
let _dlgResolve=null;
function _dlg({title,msg,icon,iconType='info',confirmText='OK',cancelText=null,inputLabel=null,inputDefault='',inputPlaceholder='',dangerous=false}){
  return new Promise(resolve=>{
    _dlgResolve=resolve;
    document.getElementById('dlgTitle').textContent=title||'';
    document.getElementById('dlgMsg').textContent=msg||'';
    document.getElementById('dlgIconEmoji').textContent=icon||'ℹ️';
    const iconWrap=document.getElementById('dlgIconWrap');
    iconWrap.className='dlg-icon-wrap '+iconType;
    if(!icon){document.getElementById('dlgIconBand').style.display='none'}
    else{document.getElementById('dlgIconBand').style.display='flex'}
    const inputWrap=document.getElementById('dlgInputWrap');
    const input=document.getElementById('dlgInput');
    if(inputLabel!==null){
      inputWrap.style.display='block';
      document.getElementById('dlgInputLabel').textContent=inputLabel;
      input.value=inputDefault;
      input.placeholder=inputPlaceholder;
    } else {
      inputWrap.style.display='none';
      input.value='';
    }
    const actions=document.getElementById('dlgActions');
    actions.innerHTML='';
    if(cancelText!==null){
      const cancel=document.createElement('button');
      cancel.className='dlg-btn secondary';cancel.textContent=cancelText;
      cancel.onclick=()=>{_closeDlg();resolve(null)};
      actions.appendChild(cancel);
    }
    const ok=document.createElement('button');
    ok.className='dlg-btn '+(dangerous?'danger-btn':'primary');
    ok.textContent=confirmText;
    ok.onclick=()=>{
      const val=inputLabel!==null?input.value:true;
      _closeDlg();resolve(val);
    };
    actions.appendChild(ok);
    document.getElementById('dlgOverlay').classList.add('open');
    setTimeout(()=>(inputLabel!==null?input:ok).focus(),60);
    input.onkeydown=e=>{
      if(e.key==='Enter'){e.preventDefault();ok.click()}
      if(e.key==='Escape'){e.preventDefault();if(cancelText!==null){_closeDlg();resolve(null)}}
    };
  });
}

function _closeDlg(){document.getElementById('dlgOverlay').classList.remove('open');_dlgResolve=null}

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('dlgOverlay').addEventListener('click',e=>{
    if(e.target===document.getElementById('dlgOverlay')&&document.getElementById('dlgInputWrap').style.display==='none'){
      _closeDlg();if(_dlgResolve)_dlgResolve(null);
    }
  });
});

function showToast(message,type='info'){
  const wrap=document.getElementById('toastWrap');
  if(!wrap)return;
  const toast=document.createElement('div');
  toast.className=`toast ${type}`;
  toast.textContent=message;
  wrap.appendChild(toast);
  window.setTimeout(()=>{
    toast.style.transition='all .35s var(--ease)';
    toast.style.opacity='0';
    toast.style.transform='translateX(24px) scale(.95)';
    setTimeout(()=>toast.remove(),350);
  },2500);
}

function setStatus(message){
  const el=document.getElementById('statusText');
  if(el)el.textContent=message;
}

function setDraft(text){
  const input=document.getElementById('msgInput');
  if(!input)return;
  input.value=text;
  autoResize(input);
  input.focus();
  setStatus('Draft ready — edit it or hit send.');
}

async function showApp(){
  document.getElementById('loginPage').style.display='none';
  document.getElementById('appPage').classList.add('visible');
  loadCalendarState();
  allChats=loadCachedChats();
  hideSetupReminder();
  updateUserUI();
  if(!curChat){ loadWelcome(); }
  await ensureOAuthConfigLoaded();
  await loadModels();
  await refreshChats();
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
}

async function ensureOAuthConfigLoaded(){
  if(googleClientId)return;
  try{
    const o=await fetch('/api/oauth-config').then(r=>r.json());
    googleClientId=o.google_client_id||'';
  }catch{}
}

function normalizeMasterPrompt(text){
  return (text||'').replace(/\s+/g,' ').trim();
}

function getMasterPrompts(){
  return [
    {icon:'⚡',label:'Plan my day',q:'Help me organize and prioritize everything on my plate today. Ask me 2 quick clarifying questions before building the plan.'},
    {icon:'✍',label:'Help me write',q:'Help me write or polish something. Start by asking what audience, tone, and outcome I want.'},
    {icon:'💡',label:'Brainstorm',q:'Brainstorm ideas with me for a project or problem. Push for novel options, then rank the top 3.'},
    {icon:'🔍',label:'Research & analyze',q:'Help me research this topic deeply. Outline the scope first, then suggest a strong investigation path.'}
  ];
}

function buildMasterPromptCards(){
  return getMasterPrompts().map(a=>`<div class="wl-action-card" onclick="fillMasterPrompt('${a.q.replace(/'/g,"\\'")}')"><span class="wl-ac-icon">${a.icon}</span><span class="wl-ac-label">${a.label}</span><span class="wl-ac-sub">Editable master prompt</span></div>`).join('');
}

function hasWidgetContent(w){
  const type=(w?.type||'focus').toLowerCase();
  if(type==='recent')return Array.isArray(w.items)&&w.items.length>0;
  if(type==='calendar')return Array.isArray(w.items)&&w.items.length>0;
  if(type==='todos')return Array.isArray(w.items)&&w.items.length>0;
  if(type==='vision')return!!(w?.text||'').trim();
  if(type==='motivation')return!!(w?.text||'').trim();
  return true;
}

function renderHomeWidget(w){
  const type=(w?.type||'focus').toLowerCase();
  const size=(w?.size||'medium').toLowerCase();
  const title=esc(w?.title||'Widget');
  const subtitle=w?.subtitle?`<div class="wl-widget-sub">${esc(w.subtitle)}</div>`:'';
  const cls=`wl-widget wl-size-${size}`;

  if(type==='recent'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>`<div class="wl-recent-item" onclick="openChat('${esc(i.id||'')}')"><span class="wl-ri-title">${esc(i.title||'Untitled')}</span></div>`).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-recent-list">${body}</div></div>`;
  }
  if(type==='calendar'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>`<div class="wl-cal-item"><div class="wl-cal-title">${esc(i.summary||'Untitled event')}</div><div class="wl-cal-time">${esc(i.when||'Upcoming')}</div></div>`).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-cal-list">${body}</div></div>`;
  }
  if(type==='todos'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>`<div class="wl-todo-item">${i.done?'✓':'○'} ${esc(i.text||'')}</div>`).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-todo-list">${body}</div></div>`;
  }
  if(type==='vision'){
    const text=(w?.text||'').trim();
    if(!text)return'';
    const meta=w?.meta?`<div class="wl-vision-meta">${esc(w.meta)}</div>`:'';
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-vision-main">${esc(text)}</div>${meta}</div>`;
  }
  if(type==='motivation'){
    const text=(w?.text||'').trim();
    if(!text)return'';
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-focus-copy">${esc(text)}</div></div>`;
  }
  return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-focus-copy">${esc(w?.text||'Ready when you are.')}</div></div>`;
}

function buildInstantHomePlan(greeting){
  const state=loadProductivityState();
  const todos=(state.todos||[]).filter(t=>!t.done).slice(0,5);
  const visions=(state.visions||[]).slice(0,1);
  const chats=(allChats||[]).slice(0,5);
  const cal=(calendarEvents||[]).slice(0,4);
  const pool=[];

  if(chats.length){
    pool.push({
      type:'recent',
      size:'medium',
      title:'Recent chats',
      items:chats.map(c=>({id:c.id,title:c.title||'Untitled'})),
    });
  }
  if(todos.length){
    pool.push({
      type:'todos',
      size:'medium',
      title:'Priority tasks',
      subtitle:`${todos.length} open`,
      items:todos,
    });
  }
  if(cal.length){
    pool.push({
      type:'calendar',
      size:'medium',
      title:'Upcoming schedule',
      items:cal,
    });
  }
  if(visions.length){
    const v=visions[0];
    pool.push({
      type:'vision',
      size:'small',
      title:'Vision target',
      text:(v.title||'').trim(),
      meta:(v.when||'').trim(),
    });
  }

  // Shuffle real data widgets
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }

  return {
    heading:'What would you like to work on today?',
    widgets:pool.slice(0,5),
  };
}

function getWelcomeHTML(greeting,homePlan){
  const displayGreeting=greeting!==undefined?greeting:getLocalTimeGreeting();
  const aiWidgets=Array.isArray(homePlan?.widgets)?homePlan.widgets:[];
  const validWidgets=aiWidgets.filter(hasWidgetContent);
  const dataCards=validWidgets.map(renderHomeWidget).filter(Boolean).join('');
  const promptCards=buildMasterPromptCards();

  // Only show data section if there are real widgets
  const dataSection=dataCards?`<div class="wl-data-section"><div class="wl-section-label">Your workspace</div><div class="wl-grid">${dataCards}</div></div>`:'';

  return `<div class="welcome">
    <div class="wl-hero">
      <h1 class="welcome-greeting">${displayGreeting}</h1>
      <p class="welcome-sub">What would you like to work on today?</p>
    </div>
    <div class="wl-prompts-section">
      <div class="wl-prompts-grid">${promptCards}</div>
    </div>
    ${dataSection}
  </div>`;
}

function typewriterEffect(el,text,speed=46){
  el.textContent='';
  let i=0;
  const tick=()=>{if(i<text.length){el.textContent+=text[i++];setTimeout(tick,speed)}};
  tick();
}

function loadCachedHomePlan(){
  try{
    const raw=localStorage.getItem(HOME_WIDGET_CACHE_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw);
    return parsed&&typeof parsed==='object'?parsed:null;
  }catch{return null;}
}

function saveCachedHomePlan(plan){
  try{localStorage.setItem(HOME_WIDGET_CACHE_KEY,JSON.stringify(plan||{}));}catch{}
}

function hasCachedHomePlan(){
  const plan=loadCachedHomePlan();
  if(!plan||typeof plan!=='object')return false;
  return !!(plan.heading||Array.isArray(plan.widgets));
}

function isWelcomeScreenVisible(){
  const area=document.getElementById('chatArea');
  return !!area?.querySelector('.welcome');
}

async function precomputeHomeWidgets(allowLiveApply=true,greeting=''){
  if(homeWidgetRefreshInFlight)return;
  homeWidgetRefreshInFlight=true;
  try{
    const plan=await fetchHomeWidgetsPlan();
    const resolved=(plan&&typeof plan==='object')?plan:{};
    if(!resolved.heading&&!Array.isArray(resolved.widgets))return;
    saveCachedHomePlan(resolved);
    if(!allowLiveApply)return;
  }catch{}
  finally{homeWidgetRefreshInFlight=false;}
}

function startHomeWidgetPrecomputeLoop(){
  if(homeWidgetRefreshTimer)return;
  homeWidgetRefreshTimer=window.setInterval(()=>{
    precomputeHomeWidgets(false);
  },180000);
}

function widgetSpanForSize(size){
  return 1;
}

function pickWidgetsForGrid(widgets,maxUnits=8){
  const out=[];
  let used=0;
  for(const w of widgets){
    const span=widgetSpanForSize(w?.size);
    if(used+span>maxUnits)continue;
    out.push(w);
    used+=span;
    if(used>=maxUnits)break;
  }
  return out;
}

function getLocalTimeGreeting(){
  const hour=new Date().getHours();
  const uname=(curUser?.name||'').split(' ')[0]||'';
  const namePart=uname?`, ${uname}`:'';
  const period=hour<5?'late night':hour<12?'morning':hour<17?'afternoon':hour<21?'evening':'late night';
  const presets={
    'late night':[
      `Burning the midnight oil${namePart}?`,
      `Late-night focus${namePart}?`,
      `Quiet hours, clear mind${namePart}.`,
    ],
    morning:[
      `Early start today${namePart}?`,
      `Morning focus, steady pace${namePart}.`,
      `Fresh morning energy${namePart}.`,
    ],
    afternoon:[
      `Afternoon rhythm holding up${namePart}?`,
      `Midday focus check${namePart}.`,
      `Keeping momentum this afternoon${namePart}?`,
    ],
    evening:[
      `Evening stretch ahead${namePart}.`,
      `Winding down or diving in${namePart}?`,
      `Golden hour thoughts${namePart}.`,
    ],
  };
  const options=presets[period]||[`Ready when you are${namePart}.`];
  return options[Math.floor(Math.random()*options.length)];
}

async function loadWelcome(force=false){
  const area=document.getElementById('chatArea');
  if(curChat&&!force)return;
  const greeting=getLocalTimeGreeting();
  const instantPlan=buildInstantHomePlan(greeting);
  area.innerHTML=getWelcomeHTML(greeting,instantPlan);
}

function loadCachedChats(){
  try{
    const raw=localStorage.getItem(CHAT_CACHE_KEY);
    if(!raw)return [];
    const parsed=JSON.parse(raw);
    return Array.isArray(parsed)?parsed:[];
  }catch{return [];}
}

function saveCachedChats(chats){
  try{localStorage.setItem(CHAT_CACHE_KEY,JSON.stringify((chats||[]).slice(0,20)));}catch{}
}

async function fetchHomeWidgetsPlan(){
  const state=loadProductivityState();
  const payload={
    todos:(state.todos||[]).slice(0,10),
    visions:(state.visions||[]).slice(0,6),
    calendar_events:(calendarEvents||[]).slice(0,8),
  };
  try{
    const r=await fetch('/api/home-widgets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    return d||{};
  }catch{
    return {};
  }
}

function fillMasterPrompt(text){
  setDraft(normalizeMasterPrompt(text));
}

function updateUserUI(){
  if(!curUser)return;
  document.getElementById('userName').textContent=curUser.name||'User';
  document.getElementById('userEmail').textContent=curUser.email||'';
  document.getElementById('userAvatar').textContent=(curUser.name||'U')[0].toUpperCase();
  const planEl=document.getElementById('userPlan');
  if(planEl){
    const plan=curUser.plan||'free';
    const labels={guest:'Guest',free:'Free',pro:'Pro ⚡',max:'Max 👑',dev:'Dev 🔧'};
    planEl.textContent=labels[plan]||'Free';
    planEl.className='plan-badge '+plan;
  }
}

// ─── Auth ─────────────────────────────────────────
async function handleGoogleCred(resp){
  try{
    const r=await fetch('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credential:resp.credential})});
    const d=await r.json();
    if(d.error){document.getElementById('loginErr').textContent=d.error;return}
    curUser=d.user; curUser.plan=d.user.plan||'free';
    // Save remember token for auto-resume on session loss
    if(d.remember_token && d.user.id){
      localStorage.setItem('nexus_uid',d.user.id);
      localStorage.setItem('nexus_remember',d.remember_token);
      localStorage.removeItem('nexus_guest_id');
    }
    theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
    applyTheme(false); onboardingChecked=false; showApp();
  }catch(e){document.getElementById('loginErr').textContent='Google auth failed'}
}

async function guestLogin(){
  try{
    const prevGid=localStorage.getItem('nexus_guest_id')||'';
    const r=await fetch('/api/auth/guest',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({guest_id:prevGid})});
    const d=await r.json();
    if(d.ok){
      isGuest=true;curUser={name:'Guest',email:'',plan:'guest'};
      if(d.guest_id) localStorage.setItem('nexus_guest_id',d.guest_id);
      showApp();
    }
    else document.getElementById('loginErr').textContent=d.error||'Guest login failed';
  }catch(e){document.getElementById('loginErr').textContent='Guest login failed'}
}

async function signOut(){
  const ok=await _dlg({title:'Sign out',msg:'Are you sure you want to sign out of Nexus?',icon:'⏻',iconType:'warn',confirmText:'Sign out',cancelText:'Cancel'});
  if(!ok)return;
  await fetch('/api/auth/logout',{method:'POST'});
  localStorage.removeItem('nexus_uid');
  localStorage.removeItem('nexus_remember');
  localStorage.removeItem('nexus_guest_id');
  curUser=null;curChat=null;allChats=[];isGuest=false;
  onboardingChecked=false;
  hideSetupReminder();
  document.getElementById('appPage').classList.remove('visible');
  document.getElementById('loginPage').style.display='flex';
  document.getElementById('loginErr').textContent='';
  googleInitDone=false;
  initGoogleAuthUI();
}

async function ensureOnboarding(force=false){
  if(isGuest||!curUser)return;
  if(onboardingChecked&&!force)return;
  try{
    const r=await fetch('/api/profile-onboarding');
    const d=await r.json();
    onboardingChecked=!!d.onboarding_complete;
    if(onboardingChecked){
      localStorage.removeItem(ONB_SKIP_KEY);
      localStorage.removeItem(ONB_NO_REMIND_KEY);
      sessionStorage.removeItem(ONB_DISMISS_KEY);
      hideSetupReminder();
      if(force){
        openOnboarding(d.profile||{});
      }
      return;
    }
    const skipped=localStorage.getItem(ONB_SKIP_KEY)==='1';
    const noRemind=localStorage.getItem(ONB_NO_REMIND_KEY)==='1';
    const dismissed=sessionStorage.getItem(ONB_DISMISS_KEY)==='1';
    if(force||!skipped){
      openOnboarding(d.profile||{});
      hideSetupReminder();
      return;
    }
    if(!noRemind&&!dismissed){
      showSetupReminder();
    }else{
      hideSetupReminder();
    }
  }catch{}
}

function showSetupReminder(){
  const bar=document.getElementById('setupReminder');
  if(!bar)return;
  bar.style.display='flex';
}

function hideSetupReminder(){
  const bar=document.getElementById('setupReminder');
  if(!bar)return;
  bar.style.display='none';
}

function dismissSetupReminder(){
  const noRemind=!!document.getElementById('setupDoNotRemind')?.checked;
  if(noRemind){
    localStorage.setItem(ONB_NO_REMIND_KEY,'1');
  }
  sessionStorage.setItem(ONB_DISMISS_KEY,'1');
  hideSetupReminder();
}

function openSetupFromReminder(){
  sessionStorage.removeItem(ONB_DISMISS_KEY);
  localStorage.removeItem(ONB_NO_REMIND_KEY);
  hideSetupReminder();
  ensureOnboarding(true);
}

function openSetupFromSettings(){
  closeM('settingsModal');
  sessionStorage.removeItem(ONB_DISMISS_KEY);
  ensureOnboarding(true);
}

function skipOnboarding(){
  localStorage.setItem(ONB_SKIP_KEY,'1');
  document.getElementById('onboardingModal').classList.remove('open');
  const noRemind=localStorage.getItem(ONB_NO_REMIND_KEY)==='1';
  if(!noRemind){
    showSetupReminder();
  }
}

function openOnboarding(profile={}){
  document.getElementById('onbName').value=profile.preferred_name||curUser?.name||'';
  document.getElementById('onbWork').value=profile.what_you_do||'';
  document.getElementById('onbHobbies').value=profile.hobbies||'';
  document.getElementById('onbFocus').value=profile.current_focus||'';
  document.getElementById('onbErr').textContent='';
  document.getElementById('onboardingModal').classList.add('open');
  setTimeout(()=>document.getElementById('onbName')?.focus(),60);
}

async function submitOnboarding(){
  const preferred_name=document.getElementById('onbName').value.trim();
  const what_you_do=document.getElementById('onbWork').value.trim();
  const hobbies=document.getElementById('onbHobbies').value.trim();
  const current_focus=document.getElementById('onbFocus').value.trim();
  const errEl=document.getElementById('onbErr');
  const btn=document.getElementById('onbSaveBtn');
  if(!preferred_name||!what_you_do||!hobbies){
    errEl.textContent='Please fill out your name, what you do, and your hobbies.';
    return;
  }
  btn.disabled=true;errEl.textContent='';
  try{
    const r=await fetch('/api/profile-onboarding',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({preferred_name,what_you_do,hobbies,current_focus})});
    const d=await r.json();
    if(!r.ok||d.error){
      errEl.textContent=d.error||'Failed to save setup.';
      btn.disabled=false;
      return;
    }
    onboardingChecked=true;
    localStorage.removeItem(ONB_SKIP_KEY);
    localStorage.removeItem(ONB_NO_REMIND_KEY);
    sessionStorage.removeItem(ONB_DISMISS_KEY);
    hideSetupReminder();
    if(curUser){curUser.name=(d.user?.name||preferred_name);updateUserUI();}
    document.getElementById('onboardingModal').classList.remove('open');
    showToast('Setup complete. Nexus is personalized for you.','success');
  }catch(e){
    errEl.textContent='Failed to save setup.';
    btn.disabled=false;
  }
}

// ─── Sidebar ──────────────────────────────────────
function toggleSB(){document.getElementById('sidebar').classList.toggle('closed')}

async function refreshChats(){
  const r=await apiFetch('/api/chats');const d=await r.json();
  allChats=d.chats||[];
  saveCachedChats(allChats);
  renderChatList();
}

function renderChatList(filter=''){
  const el=document.getElementById('chatList');
  const f=filter.toLowerCase();
  const fl=(f?allChats.filter(c=>c.title.toLowerCase().includes(f)):allChats);
  const grouped={};fl.forEach(c=>{const fld=c.folder||'';if(!grouped[fld])grouped[fld]=[];grouped[fld].push(c)});
  let html='';const seen=new Set();
  for(const fld of ['',...Object.keys(grouped).filter(f=>f).sort()]){
    if(seen.has(fld)||!grouped[fld])continue;seen.add(fld);
    if(fld)html+=`<div class="sb-folder-name">📁 ${esc(fld)}</div>`;
    for(const c of grouped[fld]){
      const a=c.id===curChat?' active':'';
      const g=isChatRunning(c.id)?' generating':'';
      html+=`<div class="sb-chat${a}${g}" onclick="openChat('${c.id}')"><span class="ct">${esc(c.title)}</span><button class="cd" onclick="event.stopPropagation();renameChat('${c.id}')" title="Rename">✎</button><button class="cd" onclick="event.stopPropagation();delChat('${c.id}')">✕</button></div>`;
    }
  }
  el.innerHTML=html||'<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:11px;line-height:1.7">No chats yet.<br>Start a conversation to see it here.</div>';
}

function filterChats(){renderChatList(document.getElementById('chatSearch').value)}

async function renameChat(id){
  const chat=allChats.find(c=>c.id===id);
  const next=await _dlg({title:'Rename chat',msg:'',icon:'✏️',iconType:'info',inputLabel:'New title',inputDefault:chat?.title||'',inputPlaceholder:'Chat title…',confirmText:'Rename',cancelText:'Cancel'});
  if(!next||!next.trim())return;
  await fetch(`/api/chats/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:next.trim()})});
  if(curChat===id)document.getElementById('topTitle').textContent=next.trim();
  await refreshChats();
  showToast('Chat renamed.','success');
}

async function createChat(folder=''){
  if(!curChat && !folder){
    loadWelcome(true);
    document.getElementById('msgInput').focus();
    return;
  }
  pendingFolder='';
  const r=await fetch('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  const c=await r.json();
  curChat=c.id;
  document.getElementById('chatArea').innerHTML='';
  loadWelcome(true);
  document.getElementById('topTitle').textContent=c.title||'New Chat';
  await refreshChats();
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  setStatus('New chat saved. Ask anything to begin.');
}

async function newFolder(){
  const n=await _dlg({title:'New folder',msg:'',icon:'📁',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create',cancelText:'Cancel'});
  if(n?.trim())createChat(n.trim());
}

async function openChat(id){
  curChat=id;
  const r=await apiFetch(`/api/chats/${id}`);
  if(!r.ok){
    // Chat no longer exists on server — remove from list and go to welcome
    showToast('Chat not found. It may have been deleted.','info');
    curChat=null;
    await refreshChats();
    loadWelcome(true);
    return;
  }
  const chat=await r.json();
  if(chat.error){
    showToast('Chat not found.','info');
    curChat=null;
    await refreshChats();
    loadWelcome(true);
    return;
  }
  document.getElementById('topTitle').textContent=chat.title||'New Chat';
  if(chat.model){
    const opts=document.querySelectorAll('.cms-opt');
    for(const opt of opts){
      if(opt.dataset.id===chat.model){
        selectModel(chat.model,opt.dataset.label,opt.dataset.provider,true);
        break;
      }
    }
  }
  const area=document.getElementById('chatArea');area.innerHTML='';
  if(chat.messages?.length){
    for(const m of chat.messages){
      if(m.role==='user')addMsg('user',m.text,[],m);
      else addMsg('kairo',m.text,m.files_modified||[],m);
    }
    setTimeout(()=>{
      try{
        Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams());
      }catch(e){
        console.log('Mermaid re-render:',e);
      }
    },200);
  }else{
    loadWelcome(true);
  }
  renderChatList(document.getElementById('chatSearch').value);
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  setStatus('Chat loaded. Continue or ask for a summary.');
}

async function delChat(id){
  const ok=await _dlg({title:'Delete chat',msg:'This chat will be permanently deleted.',icon:'🗑',iconType:'danger',confirmText:'Delete',cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  try{
    const run=runningStreams.get(id);
    if(run?.controller)run.controller.abort();
    runningStreams.delete(id);
    await fetch(`/api/chats/${id}`,{method:'DELETE'});
    if(curChat===id){
      curChat=null;
      document.getElementById('topTitle').textContent='NEXUS';
      loadWelcome(true);
    }
    await refreshChats();
    updateComposerBusyUI();
  }catch{
    showToast('Could not delete chat right now.','error');
  }
}

// ─── Models ───────────────────────────────────────
let currentModel='';
const logoUrls={
  google:'/static/logos/google.svg',
  openai:'/static/logos/openai.svg',
  anthropic:'/static/logos/anthropic.svg',
  custom:'/static/logos/custom.svg'
};

function logoImg(provider){
  const src=logoUrls[provider]||logoUrls.custom;
  return `<img class="plogo" data-p="${esc(provider)}" src="${src}" width="16" height="16">`;
}

async function loadModels(){
  try{
    const r=await fetch('/api/models');const d=await r.json();
    const drop=document.getElementById('cmsDropdown');drop.innerHTML='';
    for(const m of d.models){
      const opt=document.createElement('div');
      const locked=!m.available&&m.locked_reason==='upgrade_required';
      const unavailable=!m.available&&m.locked_reason!=='upgrade_required';
      opt.className='cms-opt'+(locked?' locked':'')+(unavailable?' locked':'');
      opt.dataset.id=m.id;
      opt.dataset.label=m.label;
      opt.dataset.provider=m.provider;
      opt.dataset.locked=locked?'1':'0';
      let badgeHTML=m.tier==='free'
        ?'<span class="cms-badge free">free</span>'
        :m.tier==='pro'?'<span class="cms-badge pro">pro</span>':'';
      const lockIcon=locked?'<span class="lock-icon">🔒</span>':'';
      opt.innerHTML=`${logoImg(m.provider)} <span>${esc(m.label)}</span>${badgeHTML}${lockIcon}`;
      opt.onclick=()=>{
        if(locked){showUpgradeForModel(m);return;}
        if(unavailable){showToast(m.locked_reason||'Model unavailable','error');return;}
        if(m.provider!=='google'){
          showToast('⚠️ '+m.label+' is not available yet. Only Gemini models are currently active.','info');
          return;
        }
        selectModel(m.id,m.label,m.provider);
      };
      drop.appendChild(opt);
      if(m.id===d.selected){
        document.getElementById('cmsCurrentIcon').innerHTML=logoImg(m.provider);
        document.getElementById('cmsCurrentText').textContent=m.label;
        currentModel=m.id;
      }
    }
  }catch(e){console.error('loadModels failed',e)}
}

function showUpgradeForModel(m){
  document.getElementById('cmsDropdown')?.classList.remove('show');
  openUpgradeModal();
  document.getElementById('upgradeModalSubtitle').textContent=
    `${m.label} requires a Pro or Max plan. Upgrade to unlock all models.`;
}

function openUpgradeModal(){
  const plan=curUser?.plan||'free';
  document.getElementById('upgradeModalSubtitle').textContent='Manage your Nexus plan.';
  ['Free','Pro','Max','Dev'].forEach(p=>{
    const el=document.getElementById('uplan'+p);
    if(el)el.classList.toggle('current',plan===p.toLowerCase());
  });
  ['free','pro','max','dev'].forEach(p=>{
    const btn=document.getElementById('upgradeBtn_'+p);
    if(btn)btn.classList.toggle('active',plan===p);
  });
  document.getElementById('upgradeModal').classList.add('open');
}

async function applyPlanChange(plan){
  if(!plan||!['free','pro','max','dev'].includes(plan))return;
  if(isGuest||!curUser){
    showToast('Sign in with Google to change plans.','info');
    return;
  }
  // Warn for non-dev plan changes (payments not available yet)
  if(plan!=='dev'){
    showToast('⚠️ Plan purchasing is not available yet. Use the Developer plan for full access.','info');
    return;
  }
  try{
    const r=await fetch('/api/auth/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'Could not update plan.','error');
      return;
    }
    curUser.plan=plan;
    updateUserUI();
    await loadModels();
    ['Free','Pro','Max','Dev'].forEach(p=>{
      const el=document.getElementById('uplan'+p);
      if(el)el.classList.toggle('current',plan===p.toLowerCase());
    });
    ['free','pro','max','dev'].forEach(p=>{
      const btn=document.getElementById('upgradeBtn_'+p);
      if(btn)btn.classList.toggle('active',plan===p);
    });
    showToast(`Plan switched to ${plan.toUpperCase()}.`,'success');
  }catch{
    showToast('Could not update plan.','error');
  }
}

async function selectModel(id,label,provider,skipUpdate=false){
  const drop=document.getElementById('cmsDropdown');
  if(drop)drop.classList.remove('show');
  if(id===currentModel)return;
  currentModel=id;
  const cmsEl=document.getElementById('cmsCurrent');
  cmsEl.classList.add('switching');
  setTimeout(()=>cmsEl.classList.remove('switching'),350);
  document.getElementById('cmsCurrentIcon').innerHTML=logoImg(provider);
  document.getElementById('cmsCurrentText').textContent=label;
  if(!skipUpdate){
    const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selected_model:id})});
    const d=await r.json();
    if(d.error){
      showToast(d.error,'error');
      await loadModels();
      return;
    }
    if(curChat)await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:id})});
    showToast(`Switched to ${label}`,'success');
  }
}

function refreshModeMenuUI(){
  const thinkItem=document.getElementById('thinkMenuItem');
  const researchItem=document.getElementById('researchMenuItem');
  const thinkBadge=document.getElementById('thinkMenuBadge');
  const researchBadge=document.getElementById('researchMenuBadge');
  if(thinkItem)thinkItem.classList.toggle('active',thinkingEnabled);
  if(researchItem)researchItem.classList.toggle('active',researchEnabled);
  if(thinkBadge)thinkBadge.textContent=thinkingEnabled?'ON':'OFF';
  if(researchBadge)researchBadge.textContent=researchEnabled?'ON':'OFF';
}

function toggleThinking(force){
  thinkingEnabled=(typeof force==='boolean')?force:!thinkingEnabled;
  refreshModeMenuUI();
  showToast(`Thinking ${thinkingEnabled?'enabled':'disabled'}.`,thinkingEnabled?'success':'info');
}

document.addEventListener('click',e=>{
  if(!e.target.closest('#cmsContainer')){
    document.getElementById('cmsDropdown')?.classList.remove('show');
  }
  if(!e.target.closest('.plus-menu-wrap')){
    closePlusMenu();
  }
});

// ─── File Upload ──────────────────────────────────
function handleFiles(input){
  for(const file of input.files){
    const reader=new FileReader();
    reader.onload=async()=>{
      const form=new FormData();form.append('file',file);
      try{
        const r=await fetch('/api/upload',{method:'POST',body:form});
        const d=await r.json();
        pendingFiles.push({name:d.name,mime:d.mime,data:d.image_data||'',text:d.text||''});
        renderPF();
      }catch(e){console.error('Upload failed',e)}
    };
    reader.readAsArrayBuffer(file);
  }
  input.value='';
}

function renderPF(){
  document.getElementById('filePreview').innerHTML=pendingFiles.map((f,i)=>{
    const t=f.mime?.startsWith('image/')&&f.data?`<img src="data:${f.mime};base64,${f.data}">`:'📄';
    return`<div class="file-chip">${t} ${esc(f.name)} <button class="fc-x" onclick="pendingFiles.splice(${i},1);renderPF()">✕</button></div>`;
  }).join('');
  if(pendingFiles.length)setStatus(`${pendingFiles.length} file${pendingFiles.length===1?'':'s'} attached and ready.`);
}

function initDropzone(){
  const area=document.querySelector('.input-area');
  const fileInput=document.getElementById('fileInput');
  if(!area||!fileInput)return;
  ['dragenter','dragover'].forEach(evt=>area.addEventListener(evt,e=>{e.preventDefault();area.classList.add('dragover');}));
  ['dragleave','drop'].forEach(evt=>area.addEventListener(evt,e=>{e.preventDefault();if(evt==='drop')return;area.classList.remove('dragover');}));
  area.addEventListener('drop',e=>{
    area.classList.remove('dragover');
    if(!e.dataTransfer?.files?.length)return;
    fileInput.files=e.dataTransfer.files;
    handleFiles(fileInput);
    showToast('Files added.','success');
  });
  document.addEventListener('paste',e=>{
    const items=e.clipboardData?.items;if(!items)return;
    for(const item of items){
      if(item.type.startsWith('image/')){
        e.preventDefault();
        const blob=item.getAsFile();if(!blob)continue;
        const form=new FormData();
        form.append('file',blob,'pasted_image.png');
        fetch('/api/upload',{method:'POST',body:form}).then(r=>r.json()).then(d=>{
          pendingFiles.push({name:d.name,mime:d.mime,data:d.image_data||'',text:d.text||''});
          renderPF();showToast('Image pasted','success');
        }).catch(()=>showToast('Paste upload failed','error'));
        break;
      }
    }
  });
}

// ─── Plus Menu ────────────────────────────────────
function togglePlusMenu(){
  const btn=document.getElementById('plusBtn');
  const popup=document.getElementById('plusPopup');
  const isOpen=popup.classList.contains('open');
  btn.classList.toggle('open',!isOpen);
  popup.classList.toggle('open',!isOpen);
}

function closePlusMenu(){
  document.getElementById('plusBtn')?.classList.remove('open');
  document.getElementById('plusPopup')?.classList.remove('open');
}

async function pasteFromClipboard(){
  try{
    const items=await navigator.clipboard.read();
    for(const item of items){
      for(const type of item.types){
        if(type.startsWith('image/')){
          const blob=await item.getType(type);
          const form=new FormData();form.append('file',blob,'pasted_image.png');
          const r=await fetch('/api/upload',{method:'POST',body:form});const d=await r.json();
          pendingFiles.push({name:d.name,mime:d.mime,data:d.image_data||'',text:d.text||''});
          renderPF();showToast('Image pasted','success');return;
        }
      }
    }
    showToast('No image in clipboard','info');
  }catch(e){showToast('Clipboard access denied — try Ctrl+V instead','info')}
}

let activeTools=[];

function activateTool(tool){
  const input=document.getElementById('msgInput');
  const toolPrefixes={
    canvas:'[Use Canvas] ',
    search:'[Search the web] ',
    mindmap:'[Create a mind map] ',
    research:'[Deep Research] ',
    summarize:'[Summarize] '
  };
  if(tool==='code'||tool==='imagegen'){showToast('Coming soon!','info');return;}
  const prefix=toolPrefixes[tool]||'';
  if(!input.value.startsWith(prefix)){
    input.value=prefix+input.value;
  }
  input.focus();
  autoResize(input);
  showToast(`${tool.charAt(0).toUpperCase()+tool.slice(1)} tool activated`,'success');
}

function toggleResearch(){
  researchEnabled=!researchEnabled;
  refreshModeMenuUI();
  showToast(`Research mode ${researchEnabled?'enabled':'disabled'}.`,researchEnabled?'success':'info');
}

function openResearchModal(){
  const q=document.getElementById('msgInput')?.value?.trim()||'';
  const rq=document.getElementById('researchQuery');
  if(rq&&!rq.value.trim()&&q)rq.value=q;
  document.getElementById('researchDepth').value=deepResearchDepth;
  // Reset to phase 1
  document.getElementById('researchPhase1').style.display='';
  document.getElementById('researchPhase2').style.display='none';
  document.getElementById('researchPhaseLoading').style.display='none';
  document.getElementById('researchPlanBtn').disabled=false;
  document.getElementById('researchModal').classList.add('open');
}

let _researchPlanData=null;

async function generateResearchPlan(){
  const q=(document.getElementById('researchQuery').value||'').trim();
  if(!q){showToast('Add a research question first.','info');return;}
  deepResearchDepth=document.getElementById('researchDepth').value||'standard';
  const btn=document.getElementById('researchPlanBtn');
  btn.disabled=true;
  document.getElementById('researchPhase1').style.display='none';
  document.getElementById('researchPhaseLoading').style.display='';
  try{
    const r=await apiFetch('/api/research/plan',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query:q,depth:deepResearchDepth})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'Failed to generate plan.','error');
      document.getElementById('researchPhase1').style.display='';
      document.getElementById('researchPhaseLoading').style.display='none';
      btn.disabled=false;
      return;
    }
    _researchPlanData={query:q,depth:deepResearchDepth,angles:d.angles||[]};
    // Show plan editor
    document.getElementById('researchPlanQuery').textContent=q;
    const planText=(d.angles||[]).map((a,i)=>`${i+1}. ${a}`).join('\n');
    document.getElementById('researchPlanEditor').value=planText;
    document.getElementById('researchPhaseLoading').style.display='none';
    document.getElementById('researchPhase2').style.display='';
  }catch(e){
    showToast('Failed to generate plan: '+e.message,'error');
    document.getElementById('researchPhase1').style.display='';
    document.getElementById('researchPhaseLoading').style.display='none';
    btn.disabled=false;
  }
}

function backToResearchInput(){
  document.getElementById('researchPhase2').style.display='none';
  document.getElementById('researchPhase1').style.display='';
  document.getElementById('researchPlanBtn').disabled=false;
}

async function confirmResearchPlan(){
  if(!_researchPlanData)return;
  const planText=document.getElementById('researchPlanEditor').value.trim();
  if(!planText){showToast('Plan cannot be empty.','info');return;}
  closeM('researchModal');
  const input=document.getElementById('msgInput');
  input.value=_researchPlanData.query;
  deepResearchDepth=_researchPlanData.depth;
  if(!researchEnabled) toggleResearch();
  // Pass the plan along through a temporary global
  window._pendingResearchPlan=planText;
  await sendMessage();
  window._pendingResearchPlan=null;
}

async function startResearchFromModal(){
  const q=(document.getElementById('researchQuery').value||'').trim();
  if(!q){showToast('Add a research question first.','info');return;}
  deepResearchDepth=document.getElementById('researchDepth').value||'standard';
  closeM('researchModal');
  const input=document.getElementById('msgInput');
  input.value=q;
  if(!researchEnabled){
    toggleResearch();
  }
  await sendMessage();
}

let _currentResearchJobId=null;
let _currentResearchReader=null;

async function cancelCurrentResearch(){
  if(!_currentResearchJobId)return;
  try{await apiFetch(`/api/research/cancel/${_currentResearchJobId}`,{method:'POST'})}catch(e){}
}

async function runDeepResearch(query,contentEl,area,planText){
  const depth=deepResearchDepth||'standard';

  const stepNames=['Plan','Search','Read','Analyze','Gap Fill','Cross-Ref','Write','Review','Cite','Export'];
  const stepIcons=['📋','🔍','📖','🧠','🔎','🔗','✍️','✅','📑','📄'];
  let currentPct=0, currentStep=0, lastMessage='Preparing research pipeline...';
  let wasCancelled=false;

  const renderProgressBar=()=>{
    const stepsHtml=stepNames.map((name,i)=>{
      let cls='research-step';
      if(i<currentStep) cls+=' done';
      else if(i===currentStep) cls+=' active';
      const icon=i<currentStep?'✓':(i===currentStep?stepIcons[i]:(i+1));
      return `<div class="${cls}"><div class="research-step-dot">${icon}</div><div class="research-step-label">${name}</div></div>`;
    }).join('');
    const lineProgress=currentStep>0?Math.min(((currentStep)/(stepNames.length-1))*100,100):0;

    contentEl.innerHTML=`
      <div class="research-badge">🔬 Deep Research · ${esc(depth)}</div>
      <div class="research-progress">
        <div class="research-progress-header">
          <span class="research-progress-title">${currentStep<stepNames.length?stepNames[currentStep]:'Complete'}...</span>
          <span class="research-progress-pct">${Math.round(currentPct)}%</span>
        </div>
        <div class="research-bar-track">
          <div class="research-bar-fill" style="width:${currentPct}%"></div>
        </div>
        <div class="research-steps">
          <div class="research-steps-line"><div class="research-steps-line-fill" style="width:${lineProgress}%"></div></div>
          ${stepsHtml}
        </div>
        <div class="research-activity">
          <span class="research-activity-dot"></span>
          <span>${esc(lastMessage)}</span>
        </div>
      </div>
      <button class="research-stop-btn" onclick="cancelCurrentResearch()" title="Stop research">■ Stop</button>`;
    area.scrollTop=area.scrollHeight;
  };

  renderProgressBar();

  const bodyObj={query,depth};
  if(planText)bodyObj.plan=planText;
  const response=await fetch('/api/research',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(bodyObj)
  });
  if(!response.ok){
    const d=await response.json().catch(()=>({error:'Failed to start research.'}));
    throw new Error(d.error||'Failed to start research.');
  }

  const reader=response.body.getReader();
  _currentResearchReader=reader;
  const decoder=new TextDecoder();
  let buffer='';

  while(true){
    const{done,value}=await reader.read();
    if(done)break;
    buffer+=decoder.decode(value,{stream:true});
    let nl;
    while((nl=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,nl).trim();
      buffer=buffer.slice(nl+1);
      if(!line)continue;
      let evt=null;
      try{evt=JSON.parse(line)}catch(e){continue}

      if(evt.type==='job_id'){
        _currentResearchJobId=evt.job_id;
      }else if(evt.type==='progress'){
        lastMessage=evt.message||'Working...';
        if(typeof evt.pct==='number') currentPct=evt.pct;
        if(typeof evt.current_step==='number') currentStep=evt.current_step-1;
        if(currentStep<0)currentStep=0;
        renderProgressBar();
      }else if(evt.type==='cancelled'){
        wasCancelled=true;
        contentEl.innerHTML=`
          <div class="research-badge">⏹ Research stopped · ${esc(depth)}</div>
          <div style="margin-top:10px;color:var(--text-secondary)">Research was cancelled.</div>
          <button class="research-regen-btn" onclick="regenerateResearch('${esc(query).replace(/'/g,"\\'")}')">🔄 Regenerate</button>`;
        setStatus('Research cancelled.');
      }else if(evt.type==='done'){
        currentPct=100;
        currentStep=stepNames.length;
        lastMessage='Research complete!';
        const report=evt.report||'';
        const srcs=evt.sources||[];
        const srcHtml=srcs.slice(0,15).map((s,i)=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title||('Source '+(i+1)))}</a></li>`).join('');
        const dl=[];
        if(evt.pdf_file)dl.push(`<a class="choice-btn" href="/api/research/download/${encodeURIComponent(evt.pdf_file)}">Download PDF</a>`);
        if(evt.md_file)dl.push(`<a class="choice-btn" href="/api/research/download/${encodeURIComponent(evt.md_file)}">Download Markdown</a>`);
        contentEl.innerHTML=`
          <div class="research-badge">✅ Research complete · ${esc(depth)} · ${Number(evt.source_count||srcs.length)} sources</div>
          <div class="research-actions">${dl.join('')}</div>
          ${srcHtml?`<div class="research-summary"><strong>Top sources</strong><ol style="margin:8px 0 0 18px">${srcHtml}</ol></div>`:''}
          <div style="margin-top:10px">${fmt(report.slice(0,32000))}</div>
          <button class="research-regen-btn" onclick="regenerateResearch('${esc(query).replace(/'/g,"\\'")}')">🔄 Regenerate</button>
        `;
        setStatus('Research complete. You can download the report.');
      }else if(evt.type==='error'){
        throw new Error(evt.error||'Research failed.');
      }
    }
  }
  _currentResearchJobId=null;
  _currentResearchReader=null;
}

function regenerateResearch(query){
  const input=document.getElementById('msgInput');
  input.value=query;
  if(!researchEnabled) toggleResearch();
  sendMessage();
}

// ─── Messaging ────────────────────────────────────
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px'}
function sendQ(t){document.getElementById('msgInput').value=t;sendMessage()}

function stripMetaBlocks(text){
  return (text||'')
    .replace(/<<<THINKING>>>[\s\S]*?(<<<END_THINKING>>>|$)/g,'')
    .replace(/<<<CHOICES>>>[\s\S]*?(<<<END_CHOICES>>>|$)/g,'')
    .trim();
}

function hasUnclosedCodeFence(text){
  return ((text||'').match(/```/g)||[]).length%2===1;
}

function registerArtifact(entry){
  const key=entry.path?`path:${entry.path}`:`title:${entry.title}:${entry.isCode?'code':'doc'}`;
  let id=artifactIndex.get(key);
  if(!id){
    id='a_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
    artifactIndex.set(key,id);
    artifactStore.unshift({id,created:Date.now(),...entry});
  }else{
    const i=artifactStore.findIndex(a=>a.id===id);
    if(i>=0)artifactStore[i]={...artifactStore[i],...entry};
  }
  return id;
}

function registerArtifactsFromReply(reply,filesModified=[]){
  const ids=[];
  let m=null; let idx=1;
  const codeRe=/```(\w*)\n([\s\S]*?)```/g;
  while((m=codeRe.exec(reply||''))!==null){
    const lang=(m[1]||'text').toLowerCase();
    const content=m[2]||'';
    const title=lang==='mermaid'?inferMindMapTitle(content,idx++):`${(lang||'code').toUpperCase()} snippet ${idx++}`;
    ids.push(registerArtifact({title,content,isCode:lang!=='text'&&lang!=='md'&&lang!=='markdown',path:''}));
  }
  for(const f of(filesModified||[])){
    if(!f?.path)continue;
    ids.push(registerArtifact({title:f.path.split('/').pop()||f.path,path:f.path,content:'',isCode:true,action:f.action||'updated'}));
  }
  return [...new Set(ids)];
}

function renderArtifactCards(ids,state='ready'){
  if(!ids?.length)return '';
  return `<div class="artifact-grid">${ids.map(id=>{
    const a=artifactStore.find(x=>x.id===id);
    if(!a)return '';
    const name=esc(a.title||a.path||'Artifact');
    const sub=esc(a.path||a.action||'Generated file');
    if(state!=='ready'){
      return `<div class="artifact-card disabled"><div class="meta"><div class="name">${name}</div><div class="sub">${sub}</div></div><span class="artifact-arrow">…</span></div>`;
    }
    return `<div class="artifact-card clickable" role="button" tabindex="0" onclick="openArtifact('${a.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openArtifact('${a.id}')}" title="Open in Canvas"><div class="meta"><div class="name">${name}</div><div class="sub">${sub}</div></div><span class="artifact-arrow">↗</span></div>`;
  }).join('')}</div>`;
}

async function ensureArtifactContent(artifact){
  if(!artifact||artifact.content)return artifact;
  if(!artifact.path)return artifact;
  if(workspaceFileCache.has(artifact.path)){
    artifact.content=workspaceFileCache.get(artifact.path);
    return artifact;
  }
  try{
    const r=await fetch(`/api/files/content?path=${encodeURIComponent(artifact.path)}`);
    const d=await r.json();
    if(!d.error&&typeof d.content==='string'){
      workspaceFileCache.set(artifact.path,d.content);
      artifact.content=d.content;
    }
  }catch{}
  return artifact;
}

async function openArtifact(id){
  const artifact=artifactStore.find(a=>a.id===id);
  if(!artifact)return;
  await ensureArtifactContent(artifact);
  openCanvas(artifact.content||'',artifact.title||artifact.path||'Artifact',artifact.isCode,{openPanel:true,sourcePath:artifact.path||''});
}

async function sendMessage(){
  const input=document.getElementById('msgInput');const text=input.value.trim();
  if(!text&&!pendingFiles.length)return;
  if(curChat&&isChatRunning(curChat)){showToast('This chat is still generating. Open a new chat or wait.','info');return;}
  // Force-create a new chat if none exists (don't rely on createChat guard)
  if(!curChat){
    try{
      const cr=await apiFetch('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:pendingFolder||''})});
      const cc=await cr.json();
      if(cc.error){showToast('Could not create chat: '+cc.error,'error');return;}
      curChat=cc.id;
      pendingFolder='';
      document.getElementById('topTitle').textContent=cc.title||'New Chat';
      refreshChats();
    }catch(e){showToast('Failed to create chat: '+e.message,'error');return;}
  }
  const targetChatId=curChat;

  const w=document.querySelector('#chatArea .welcome');
  if(w){
    // Choreographed exit: widgets shrink first, then hero fades
    const widgets=w.querySelectorAll('.wl-widget');
    const hero=w.querySelector('.wl-hero');
    widgets.forEach((el,i)=>{
      el.style.transition=`all .25s var(--ease) ${i*0.03}s`;
      el.style.opacity='0';
      el.style.transform='translateY(-10px) scale(.96)';
    });
    if(hero){
      hero.style.transition='all .3s var(--ease) .1s';
      hero.style.opacity='0';
      hero.style.transform='translateY(-14px)';
    }
    w.style.transition='all .35s var(--ease) .15s';
    w.style.opacity='0';
    setTimeout(()=>{if(w.parentNode)w.remove();},400);
  }
  const files=[...pendingFiles];

  addMsg('user',text,[],{fileNames:files.map(f=>f.name),files});
  setStatus('Working on it...');
  input.value='';input.style.height='auto';
  pendingFiles=[];renderPF();
  for(const f of files)uploadedHistory.unshift({name:f.name,mime:f.mime,when:Date.now()});

  // ── Research when explicitly toggled or auto-detected ──
  let useResearch=researchEnabled;

  if(useResearch){
    if(files.length){showToast('Deep Research ignores attachments for now.','info');}
    const planText=window._pendingResearchPlan||null;
    window._pendingResearchPlan=null;
    if(!planText){
      // No plan yet — show the plan modal so user can review before starting
      document.getElementById('researchQuery').value=text;
      input.value=text; // keep it in the input
      openResearchModal();
      // Auto-trigger plan generation
      generateResearchPlan();
      return;
    }
    setChatRunning(targetChatId,true,{type:'research'});
    const area=document.getElementById('chatArea');
    const msgDiv=document.createElement('div');
    msgDiv.className='msg kairo';
    msgDiv.innerHTML='<div class="lbl">Nexus</div><div class="msg-content"></div>';
    area.appendChild(msgDiv);area.scrollTop=area.scrollHeight;
    const contentEl=msgDiv.querySelector('.msg-content');
    try{
      await runDeepResearch(text,contentEl,area,planText);
      await refreshChats();
    }catch(e){
      contentEl.innerHTML=`<div style="color:var(--red)">${esc(e.message||'Research failed.')}</div>`;
      setStatus('Research failed.');
    }finally{
      setChatRunning(targetChatId,false);
    }
    return;
  }

  const controller=new AbortController();
  setChatRunning(targetChatId,true,{type:'chat',controller});
  const area=document.getElementById('chatArea');

  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  msgDiv.innerHTML='<div class="lbl">Nexus</div><div class="msg-content"><div class="think-active" style="animation:thinkingIn .4s var(--ease-spring-snappy) both"><div class="dots"><span></span><span></span><span></span></div><span id="_thinkPhrase"> Thinking...</span></div></div>';
  area.appendChild(msgDiv);area.scrollTop=area.scrollHeight;
  startThinkingPhrases(msgDiv.querySelector('#_thinkPhrase'));
  const contentEl=msgDiv.querySelector('.msg-content');
  const canRender=()=>curChat===targetChatId&&msgDiv.isConnected;

  try{
    const response=await apiFetch(`/api/chats/${targetChatId}/stream`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:text,files,thinking:thinkingEnabled}),signal:controller.signal});

    const ct=response.headers.get('content-type')||'';
    if(ct.includes('application/json')){
      const d=await response.json();
      if(d.guest_limit){
        msgDiv.remove();
        showGuestLimit();
        setChatRunning(targetChatId,false);
        return;
      }
      if(d.error){
        // If chat was not found, re-create it and retry once
        if(response.status===404 && !sendMessage._retried){
          sendMessage._retried=true;
          msgDiv.remove();
          setChatRunning(targetChatId,false);
          curChat=null;
          await createChat(pendingFolder||'');
          document.getElementById('msgInput').value=text;
          pendingFiles=files;
          renderPF();
          await sendMessage();
          sendMessage._retried=false;
          return;
        }
        sendMessage._retried=false;
        if(canRender())contentEl.innerHTML=`<div style="color:var(--red)">${esc(d.error)}</div>`;
        setChatRunning(targetChatId,false);
        return;
      }
    }

    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let buffer='',fullText='';

    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      let nlIdx;
      while((nlIdx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,nlIdx).trim();
        buffer=buffer.slice(nlIdx+1);
        if(!line)continue;
        try{
          const data=JSON.parse(line);
          if(data.type==='delta'){
            stopThinkingPhrases();
            fullText+=data.text;
            if(canRender()){
              const preview=esc(stripMetaBlocks(fullText));
              const generating=hasUnclosedCodeFence(fullText)?'<div class="stream-state">🛠 Generating file artifact...</div>':'';
              contentEl.innerHTML=`<div class="stream-preview">${preview||'...'}</div>${generating}`;
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='done'){
            // Morph thinking indicator into response
            const thinkIndicator=contentEl.querySelector('.think-active');
            if(thinkIndicator){
              thinkIndicator.style.transition='all .25s var(--ease)';
              thinkIndicator.style.opacity='0';
              thinkIndicator.style.transform='translateY(-6px) scale(.97)';
              thinkIndicator.style.maxHeight='0';
              thinkIndicator.style.padding='0';
              thinkIndicator.style.margin='0';
            }
            await new Promise(r=>setTimeout(r,200));
            let finalHTML='';
            let displayReply=data.reply||'';
            if(displayReply.includes('<<<THINKING>>>')&&displayReply.includes('<<<END_THINKING>>>')){
              const parts=displayReply.split('<<<END_THINKING>>>');
              const thinkPart=parts[0].replace('<<<THINKING>>>','').trim();
              displayReply=parts.slice(1).join('<<<END_THINKING>>>').trim();
              finalHTML+=renderThinkBlock(thinkPart);
            }
            let choices=[];
            const choiceMatch=displayReply.match(/<<<CHOICES>>>\n([\s\S]*?)<<<END_CHOICES>>>/);
            if(choiceMatch){
              choices=choiceMatch[1].trim().split('\n').filter(c=>c.trim());
              displayReply=displayReply.replace(/<<<CHOICES>>>[\s\S]*?<<<END_CHOICES>>>/,'').trim();
            }
            finalHTML+=fmt(displayReply);
            if(choices.length){
              finalHTML+='<div class="choice-grid">';
              for(const c of choices)finalHTML+=`<button class="choice-btn" onclick="sendQ('${esc(c.trim()).replace(/'/g,"\\'")}');this.parentElement.remove()">${esc(c.trim())}</button>`;
              finalHTML+='</div>';
            }
            const artifactIds=registerArtifactsFromReply(displayReply,data.files||[]);
            if(data.files?.length){
              finalHTML+='<div class="fops">';
              for(const f of data.files)finalHTML+=`<div class="fo">● ${f.action}: ${esc(f.path)}</div>`;
              finalHTML+='</div>';
            }
            finalHTML+=renderArtifactCards(artifactIds,'ready');
            if(data.memory_added?.length)finalHTML+=`<div class="mops">🧠 Remembered: ${data.memory_added.map(esc).join('; ')}</div>`;

            // ── AI-triggered deep research ──
            if(data.research_trigger){
              const rq=data.research_trigger;
              setTimeout(()=>{
                document.getElementById('researchQuery').value=rq;
                openResearchModal();
                generateResearchPlan();
              },400);
            }

            if(canRender()){
              contentEl.style.opacity='0';
              contentEl.style.transform='translateY(6px)';
              contentEl.innerHTML=finalHTML;
              // Animate content in
              requestAnimationFrame(()=>{
                contentEl.style.transition='opacity .35s var(--ease-out), transform .35s var(--ease-out)';
                contentEl.style.opacity='1';
                contentEl.style.transform='translateY(0)';
              });
              if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              try{Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams())}catch{}
            }
            refreshChats();
            setStatus('Done. Ask a follow-up or start something new.');
          }else if(data.type==='error'){
            if(canRender())contentEl.innerHTML=`<div style="color:var(--red)">${esc(data.error)}</div>`;
          }
        }catch(e){}
      }
    }
  }catch(e){
    if(e.name==='AbortError'){
      stopThinkingPhrases();
      if(canRender()&&(!contentEl.innerHTML||contentEl.querySelector('.think-active'))){msgDiv.remove();}
    }else{
      stopThinkingPhrases();
      const errDetail=e.message||'Unknown error';
      if(canRender())contentEl.innerHTML=`<div style=\"color:var(--red)\">Connection error: ${esc(errDetail)}<br><small>Is the server running? Check your network.</small></div>`;
    }
  }finally{
    setChatRunning(targetChatId,false);
  }
}

function renderThinkBlock(thinkText){
  const lines=thinkText.split('\n').filter(l=>l.trim());
  const summary=lines[0]?lines[0].replace(/^[-•*]\s*/,'').slice(0,60):'Reasoning...';
  return `<div class="think-block" onclick="this.classList.toggle('expanded')">
    <div class="think-header"><span>💭</span> <span>Thought about: ${esc(summary)}</span> <span class="think-chevron">▾</span></div>
    <div class="think-content">${esc(thinkText)}</div>
  </div>`;
}

function addMsg(role,text,files,extra={}){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className=`msg ${role}`;let html='';
  if(role==='kairo')html+='<div class="lbl">Nexus</div>';
  if(role==='user'&&extra.fileNames?.length)html+=`<div class="msg-f">📎 ${extra.fileNames.map(esc).join(', ')}</div>`;
  if(role==='user'&&extra.files?.length){
    const previews=extra.files.map(f=>{
      const name=esc(f.name||'upload');
      if(f.mime?.startsWith('image/')&&f.data){
        return `<div class="user-file-preview image"><img src="data:${f.mime};base64,${f.data}" alt="${name}" loading="lazy"><span>${name}</span></div>`;
      }
      return `<div class="user-file-preview"><span>📄 ${name}</span></div>`;
    }).join('');
    html+=`<div class="msg-user-files">${previews}</div>`;
  }
  let displayText=text||'';
  if(displayText.includes('<<<THINKING>>>')&&displayText.includes('<<<END_THINKING>>>')){
    const parts=displayText.split('<<<END_THINKING>>>');
    const thinkPart=parts[0].replace('<<<THINKING>>>','').trim();
    displayText=parts.slice(1).join('<<<END_THINKING>>>').trim();
    html+=renderThinkBlock(thinkPart);
  }
  let choices=[];
  const choiceMatch=displayText.match(/<<<CHOICES>>>\n([\s\S]*?)<<<END_CHOICES>>>/);
  if(choiceMatch){
    choices=choiceMatch[1].trim().split('\n').filter(c=>c.trim());
    displayText=displayText.replace(/<<<CHOICES>>>[\s\S]*?<<<END_CHOICES>>>/,'').trim();
  }
  html+=fmt(displayText);
  if(choices.length&&role==='kairo'){
    html+='<div class="choice-grid">';
    for(const c of choices){
      html+=`<button class="choice-btn" onclick="sendQ('${esc(c.trim()).replace(/'/g,"\\'")}');this.parentElement.remove()">${esc(c.trim())}</button>`;
    }
    html+='</div>';
  }
  let artifactIds=[];
  if(role==='kairo')artifactIds=registerArtifactsFromReply(displayText,files||[]);
  if(files?.length){html+='<div class="fops">';for(const f of files)html+=`<div class="fo">● ${f.action}: ${esc(f.path)}</div>`;html+='</div>'}
  if(artifactIds.length)html+=renderArtifactCards(artifactIds,'ready');
  if(extra.memory_added?.length)html+=`<div class="mops">🧠 Remembered: ${extra.memory_added.map(esc).join('; ')}</div>`;
  if(role==='user'&&text)html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="editMsg(this)">✎ Edit</button></div>`;
  else if(role==='kairo')html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="retryMsg(this)">↺ Retry</button></div>`;
  div.dataset.text=text||'';
  div.innerHTML=html;area.appendChild(div);area.scrollTop=area.scrollHeight;
}

function addThinking(){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className='thinking';div.innerHTML='<div class="dots"><span></span><span></span><span></span></div> Nexus is thinking...';
  area.appendChild(div);area.scrollTop=area.scrollHeight;return div;
}

let _canvasBlockId=0;
function sanitizeMermaidSource(src){
  // Fix common mindmap issues: unbalanced parens/brackets in node text
  const lines=src.split('\n');
  const out=[];
  for(const line of lines){
    let l=line;
    // For mindmap nodes (indented lines that aren't the keyword line)
    if(/^\s+/.test(l)&&!/^\s*(mindmap|graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt|journey|pie)\b/i.test(l.trim())){
      // Remove problematic chars in node text that break mermaid mindmap parser
      // But preserve indentation exactly
      const indent=l.match(/^(\s*)/)[1];
      let text=l.slice(indent.length);
      // Strip shape markers like (...), [...], {{...}}, ((...)) and just use plain text
      text=text.replace(/^\(+([^)]*)\)+$/,'$1').replace(/^\[+([^\]]*)\]+$/,'$1').replace(/^\{\{([^}]*)\}\}$/,'$1');
      // Escape remaining problematic chars
      text=text.replace(/[()[\]{}]/g,' ').replace(/:/g,' -').replace(/"/g,"'");
      l=indent+text;
    }
    out.push(l);
  }
  return out.join('\n');
}

// ─── Inline interactive todo lists ─────────────────
function renderChatTodoList(listId){
  const items=chatTodoStore.get(listId)||[];
  const doneCount=items.filter(i=>i.done).length;
  const total=items.length;
  const pct=total?Math.round(doneCount/total*100):0;
  let html=`<div class="chat-todo" data-list-id="${listId}">`;
  html+=`<div class="chat-todo-header"><span class="chat-todo-icon">☑</span><span class="chat-todo-title">${doneCount}/${total} completed</span><div class="chat-todo-bar"><div class="chat-todo-bar-fill" style="width:${pct}%"></div></div></div>`;
  html+=`<div class="chat-todo-items">`;
  items.forEach(item=>{
    const checked=item.done?'checked':'';
    const doneClass=item.done?'done':'';
    html+=`<div class="chat-todo-row ${doneClass}" data-item-id="${item.id}">`;
    html+=`<button class="chat-todo-check ${checked}" onclick="toggleChatTodo('${listId}','${item.id}')"><span>${item.done?'✓':''}</span></button>`;
    html+=`<span class="chat-todo-text" ondblclick="editChatTodo('${listId}','${item.id}',this)">${esc(item.text)}</span>`;
    html+=`<button class="chat-todo-del" onclick="deleteChatTodo('${listId}','${item.id}')" title="Delete">✕</button>`;
    html+=`</div>`;
  });
  html+=`</div>`;
  html+=`<div class="chat-todo-footer"><button class="chat-todo-add" onclick="addChatTodo('${listId}')">+ Add task</button></div>`;
  html+=`</div>`;
  return html;
}

function reRenderChatTodo(listId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const tmp=document.createElement('div');
  tmp.innerHTML=renderChatTodoList(listId);
  el.replaceWith(tmp.firstElementChild);
  // Also sync to localStorage productivity state
  syncChatTodosToStorage(listId);
}

function syncChatTodosToStorage(listId){
  const items=chatTodoStore.get(listId)||[];
  const state=loadProductivityState();
  // Remove old items from this list, add current ones
  state.todos=state.todos.filter(t=>!t.id.startsWith(listId));
  items.forEach(it=>{state.todos.push({id:it.id,text:it.text,done:it.done});});
  saveProductivityState(state);
}

function toggleChatTodo(listId,itemId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const item=items.find(i=>i.id===itemId);
  if(!item)return;
  item.done=!item.done;
  reRenderChatTodo(listId);
}

function deleteChatTodo(listId,itemId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  chatTodoStore.set(listId,items.filter(i=>i.id!==itemId));
  reRenderChatTodo(listId);
}

function editChatTodo(listId,itemId,el){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const item=items.find(i=>i.id===itemId);
  if(!item)return;
  const input=document.createElement('input');
  input.type='text';input.value=item.text;
  input.className='chat-todo-edit-input';
  const commit=()=>{
    const val=input.value.trim();
    if(val)item.text=val;
    reRenderChatTodo(listId);
  };
  input.onblur=commit;
  input.onkeydown=e=>{if(e.key==='Enter')commit();if(e.key==='Escape')reRenderChatTodo(listId);};
  el.textContent='';
  el.appendChild(input);
  input.focus();input.select();
}

function addChatTodo(listId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const newId=listId+'_'+Date.now().toString(36);
  items.push({id:newId,text:'New task',done:false});
  reRenderChatTodo(listId);
  // Auto-focus edit on the new item
  setTimeout(()=>{
    const row=document.querySelector(`.chat-todo[data-list-id="${listId}"] .chat-todo-row[data-item-id="${newId}"] .chat-todo-text`);
    if(row)editChatTodo(listId,newId,row);
  },50);
}

function fmt(text){
  if(!text)return'';let t=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let blocks=[];
  t=t.replace(/```mermaid\n([\s\S]*?)```/g,(_,c)=>{
    let restored=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    // Sanitize mindmap source to fix common syntax issues
    if(/^\s*mindmap\b/i.test(restored)) restored=sanitizeMermaidSource(restored);
    const mindId='mm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
    const title=inferMindMapTitle(restored,blocks.length+1);
    mindMapStore.set(mindId,{title,source:restored});
    blocks.push(`<div class="mermaid-container" data-mindmap-id="${mindId}"><div class="mermaid-toolbar"><button type="button" onclick="openMindMapCanvas('${mindId}')">Open in Canvas</button><a class="mm-download" href="#" onclick="return false">Download PNG</a></div><pre class="mermaid">${restored}</pre></div>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Interactive todo lists
  t=t.replace(/```todolist\n([\s\S]*?)```/g,(_,c)=>{
    const raw=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
    try{
      const items=JSON.parse(raw);
      if(Array.isArray(items)){
        const listId='tl_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
        chatTodoStore.set(listId,items.map((it,i)=>({id:listId+'_'+i,text:it.text||'',done:!!it.done})));
        blocks.push(renderChatTodoList(listId));
        return `%%%BLOCK${blocks.length-1}%%%`;
      }
    }catch(e){}
    blocks.push(`<pre style="background:var(--bg-deep);padding:14px 16px;border-radius:var(--r-sm);overflow-x:auto;font-family:var(--mono);font-size:11.5px;margin:10px 0;border:1px solid var(--border);line-height:1.65"><code>${c}</code></pre>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  t=t.replace(/```(\w*)\n([\s\S]*?)```/g,(_,l,c)=>{
    const bid=_canvasBlockId++;
    window['_cblk'+bid]=c;
    blocks.push(`<pre style="background:var(--bg-deep);padding:14px 16px;border-radius:var(--r-sm);overflow-x:auto;font-family:var(--mono);font-size:11.5px;margin:10px 0;border:1px solid var(--border);line-height:1.65"><code>${c}</code></pre><button class="canvas-btn" onclick="openCanvas(window['_cblk${bid}'],'${(l||'Code').replace(/'/g,'')}',true)">✏️ Edit in Canvas</button>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Markdown images: ![alt](url)
  t=t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,(_,alt,url)=>{
    const safeAlt=alt.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    blocks.push(`<div class="msg-img-wrap"><img src="${url}" alt="${safeAlt}" style="max-width:100%;border-radius:var(--r-md);box-shadow:var(--shadow-sm)" loading="lazy" onerror="this.parentElement.style.display='none'" onclick="openImageLightbox(this.src,this.alt)"><button class="img-expand-btn" onclick="openImageLightbox('${url}','${safeAlt.replace(/'/g,"\\'")}')">⤢</button></div>`);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Markdown links: [text](url) — but not images (already handled)
  t=t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/`(.+?)`/g,'<code style="background:var(--bg-surface);padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11.5px;border:1px solid var(--border)">$1</code>');
  t=t.replace(/\n/g,'<br>');
  blocks.forEach((b,i)=>{t=t.replace(`%%%BLOCK${i}%%%`,b);});
  return t;
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

function openImageLightbox(src,alt){
  let lb=document.getElementById('imgLightbox');
  if(!lb){
    lb=document.createElement('div');
    lb.id='imgLightbox';
    lb.className='img-lightbox';
    lb.onclick=e=>{if(e.target===lb)closeImageLightbox()};
    lb.innerHTML='<div class="img-lb-close" onclick="closeImageLightbox()">\u2715</div><img class="img-lb-img">';
    document.body.appendChild(lb);
  }
  const img=lb.querySelector('img');
  img.src=src;
  img.alt=alt||'';
  lb.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeImageLightbox(){
  const lb=document.getElementById('imgLightbox');
  if(lb)lb.classList.remove('open');
  document.body.style.overflow='';
}

function inferMindMapTitle(source,fallbackIndex=1){
  const lines=(source||'').split('\n').map(l=>l.trim()).filter(Boolean);
  for(const line of lines){
    if(/^(mindmap|graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt|journey|pie)\b/i.test(line))continue;
    const cleaned=line
      .replace(/^[\-+*#>\d.\s]+/,'')
      .replace(/:::.+$/,'')
      .replace(/[{}\[\]()]/g,'')
      .replace(/\s+/g,' ')
      .trim();
    if(cleaned.length>=3){
      return `Mind map: ${cleaned.slice(0,56)}`;
    }
  }
  return `Mind map ${fallbackIndex}`;
}

// ─── Settings ─────────────────────────────────────
async function openSettings(){
  document.getElementById('settingsModal').classList.add('open');
  const dark=document.getElementById('themeBtn_dark');
  const light=document.getElementById('themeBtn_light');
  if(dark&&light){
    const activeStyle='background:var(--bg-surface);color:var(--text-primary);border-radius:5px;';
    const inactiveStyle='background:transparent;color:var(--text-muted);';
    dark.style.cssText=(theme==='dark'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
    light.style.cssText=(theme==='light'?activeStyle:inactiveStyle)+'padding:7px 14px;font-size:11px;font-weight:500;border:none;cursor:pointer;transition:all .2s;';
  }
  if(curUser)document.getElementById('profileName').value=curUser.name||'';
  renderCalendarStatus();
  openMemory();
}

async function saveKey(p,id){
  const k=document.getElementById(id).value.trim();if(!k)return;
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:{[p]:k}})});
  document.getElementById(id).value='';await loadModels();openSettings();
  showToast('API key saved.','success');
}

async function delKey(p){
  await fetch('/api/settings/key',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:p})});
  await loadModels();openSettings();
  showToast('API key removed.','info');
}

async function addEP(){
  const name=await _dlg({title:'Add endpoint',msg:'Enter a label for this endpoint.',icon:'🔌',iconType:'info',inputLabel:'Endpoint name',inputDefault:'',inputPlaceholder:'e.g. OpenRouter',confirmText:'Next',cancelText:'Cancel'});
  if(!name)return;
  const url=await _dlg({title:'Add endpoint',msg:'Enter the base URL for this endpoint.',icon:'🔌',iconType:'info',inputLabel:'Base URL',inputDefault:'',inputPlaceholder:'https://openrouter.ai/api/v1',confirmText:'Next',cancelText:'Cancel'});
  if(!url)return;
  const model=await _dlg({title:'Add endpoint',msg:'Optionally enter a default model name.',icon:'🔌',iconType:'info',inputLabel:'Model name (optional)',inputDefault:'',inputPlaceholder:'e.g. openai/gpt-4o',confirmText:'Add',cancelText:'Skip'});
  const finalModel=model||'';
  const r=await fetch('/api/settings');const s=await r.json();
  const eps=[...(s.custom_endpoints||[]),{name,base_url:url,model:finalModel,provider_type:'openai'}];
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({custom_endpoints:eps})});
  await loadModels();openSettings();
  showToast('Endpoint added.','success');
}

async function removeEP(i){
  const r=await fetch('/api/settings');const s=await r.json();
  const eps=s.custom_endpoints||[];eps.splice(i,1);
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({custom_endpoints:eps})});
  await loadModels();openSettings();
  showToast('Endpoint removed.','info');
}

async function saveName(){
  const name=document.getElementById('profileName').value.trim();if(!name)return;
  await fetch('/api/auth/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  curUser.name=name;updateUserUI();
  showToast('Profile updated.','success');
}

function loadCalendarState(){
  try{
    const raw=localStorage.getItem(CALENDAR_STATE_KEY);
    if(!raw)return;
    const parsed=JSON.parse(raw);
    calendarEvents=Array.isArray(parsed.events)?parsed.events:[];
  }catch{
    calendarEvents=[];
  }
}

function saveCalendarState(){
  const safe={events:(calendarEvents||[]).slice(0,8)};
  localStorage.setItem(CALENDAR_STATE_KEY,JSON.stringify(safe));
}

function renderCalendarStatus(){
  const statusEl=document.getElementById('calendarStatus');
  const cBtn=document.getElementById('calendarConnectBtn');
  const dBtn=document.getElementById('calendarDisconnectBtn');
  if(statusEl){
    if(calendarToken)statusEl.textContent=`Calendar connected. Showing ${calendarEvents.length} upcoming events.`;
    else if(calendarEvents.length)statusEl.textContent=`Calendar events cached (${calendarEvents.length}). Reconnect to refresh.`;
    else statusEl.textContent='Calendar not connected.';
  }
  if(cBtn)cBtn.disabled=!!calendarToken;
  if(dBtn)dBtn.disabled=!calendarToken;
}

function connectGoogleCalendar(){
  ensureOAuthConfigLoaded().then(()=>{
    if(!googleClientId){showToast('Google client ID is missing.','error');return;}
    if(!window.google?.accounts?.oauth2){showToast('Google OAuth is not available yet.','error');return;}
    if(!calendarTokenClient){
      calendarTokenClient=google.accounts.oauth2.initTokenClient({
        client_id:googleClientId,
        scope:'https://www.googleapis.com/auth/calendar.readonly',
        callback:(resp)=>{
          if(resp?.error){showToast('Calendar connect failed.','error');return;}
          calendarToken=resp.access_token||'';
          renderCalendarStatus();
          refreshGoogleCalendarEvents();
        }
      });
    }
    calendarTokenClient.requestAccessToken({prompt:'consent'});
  });
}

function disconnectGoogleCalendar(){
  calendarToken='';
  calendarEvents=[];
  saveCalendarState();
  renderCalendarStatus();
  loadWelcome(true);
  showToast('Calendar disconnected.','info');
}

async function refreshGoogleCalendarEvents(){
  if(!calendarToken){showToast('Connect Google Calendar first.','info');return;}
  try{
    const timeMin=encodeURIComponent(new Date().toISOString());
    const url=`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=8&timeMin=${timeMin}`;
    const r=await fetch(url,{headers:{Authorization:`Bearer ${calendarToken}`}});
    const d=await r.json();
    if(!r.ok){
      showToast(d?.error?.message||'Could not load calendar events.','error');
      return;
    }
    calendarEvents=(d.items||[]).map(ev=>{
      const start=ev.start?.dateTime||ev.start?.date||'';
      let when='Upcoming';
      if(start){
        const dt=new Date(start);
        if(!Number.isNaN(dt.getTime()))when=dt.toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      }
      return {summary:ev.summary||'Untitled event',when};
    });
    saveCalendarState();
    renderCalendarStatus();
    if(!curChat)loadWelcome(true);
    showToast('Calendar events updated.','success');
  }catch{
    showToast('Could not load calendar events.','error');
  }
}

// ─── Memory ───────────────────────────────────────
async function openMemory(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/memory');const m=await r.json();
  document.getElementById('memList').innerHTML=(m.facts||[]).map((f,i)=>
    `<div class="mem-item"><span>${esc(f)}</span><button onclick="delMem(${i})">✕</button></div>`
  ).join('')||'<div style="color:var(--text-muted);font-size:11px;padding:8px">No memories yet. Try saying "remember that..." in a chat.</div>';
}

async function addMem(){
  const inp=document.getElementById('memInput');const f=inp.value.trim();if(!f)return;
  await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fact:f})});
  inp.value='';openMemory();
}

async function delMem(i){await fetch(`/api/memory/${i}`,{method:'DELETE'});openMemory()}

// ─── My Data ──────────────────────────────────────
async function openData(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/auth/data');const d=await r.json();
  document.getElementById('dataInfo').innerHTML=`<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
    <strong style="color:var(--text-primary)">${esc(d.user.name)}</strong> · ${esc(d.user.email)} · ${esc(d.user.provider)} · since ${d.user.created?.split('T')[0]||'?'}</div>`;
  document.getElementById('dataStats').innerHTML=
    `<div class="ds"><span class="num">${d.stats.chats}</span>Chats</div>
     <div class="ds"><span class="num">${d.stats.messages}</span>Messages</div>
     <div class="ds"><span class="num">${d.stats.memory_facts}</span>Memories</div>
     <div class="ds"><span class="num">${d.stats.uploaded_files}</span>Uploads</div>
     <div class="ds"><span class="num">${d.stats.api_keys}</span>API Keys</div>`;
  document.getElementById('dataMemory').innerHTML=(d.memory||[]).map(f=>`<div style="padding:2px 0">• ${esc(f)}</div>`).join('')||'None';
  document.getElementById('dataChats').innerHTML=(d.chats||[]).map(c=>`<div style="padding:2px 0">💬 ${esc(c.title)} (${c.messages} msgs)</div>`).join('')||'None';
}

async function resetData(){
  const code=document.getElementById('resetCode').value.trim();
  if(code!=='DELETE-MY-DATA'){
    await _dlg({title:'Incorrect confirmation',msg:'Please type DELETE-MY-DATA exactly in the field above.',icon:'⚠️',iconType:'warn',confirmText:'OK'});
    return;
  }
  const step1=await _dlg({title:'Delete all data?',msg:'This will permanently erase all your chats, memory, uploads, and settings. There is no undo.',icon:'⚠️',iconType:'danger',confirmText:'Yes, delete everything',cancelText:'Cancel',dangerous:true});
  if(!step1)return;
  const step2=await _dlg({title:'Final confirmation',msg:'Last chance — this action is irreversible.',icon:'🔥',iconType:'danger',confirmText:'Permanently delete',cancelText:'Cancel',dangerous:true});
  if(!step2)return;
  const r=await fetch('/api/auth/data',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  const d=await r.json();
  if(d.ok){
    closeM('settingsModal');curChat=null;
    document.getElementById('chatArea').innerHTML='';document.getElementById('topTitle').textContent='NEXUS';
    await refreshChats();await loadModels();
    showToast('All data has been reset.','success');
  }else{
    await _dlg({title:'Reset failed',msg:d.error||'Something went wrong.',icon:'✕',iconType:'danger',confirmText:'OK'});
  }
  document.getElementById('resetCode').value='';
}

// ─── Files ────────────────────────────────────────
async function openFiles(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/files');const d=await r.json();
  document.getElementById('filesList').innerHTML=(d.files||[]).map(f=>
    `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="font-size:12px;color:var(--text-primary);font-weight:500">${esc(f.path)}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${f.size.toLocaleString()} chars</div></div>`
  ).join('')||'<div style="color:var(--text-muted);font-size:11px">No workspace files found.</div>';
}

async function openFileHub(){
  document.getElementById('fileHubModal').classList.add('open');
  await refreshFileHub();
}

async function refreshFileHub(){
  const uploadsEl=document.getElementById('hubUploads');
  const artEl=document.getElementById('hubArtifacts');
  const wsEl=document.getElementById('hubWorkspace');
  if(!uploadsEl||!artEl||!wsEl)return;

  uploadsEl.innerHTML=uploadedHistory.length
    ?uploadedHistory.slice(0,40).map(u=>`<div class="hub-item"><div class="left"><div class="name">${esc(u.name)}</div><div class="meta">${esc(u.mime||'file')} · ${new Date(u.when).toLocaleString()}</div></div></div>`).join('')
    :'<div style="color:var(--text-muted);font-size:11px">No uploads yet.</div>';

  artEl.innerHTML=artifactStore.length
    ?artifactStore.slice(0,80).map(a=>`<div class="hub-item"><div class="left"><div class="name">${esc(a.title||a.path||'Artifact')}</div><div class="meta">${esc(a.path||a.action||'Generated content')}</div></div><button onclick="openArtifact('${a.id}')">Open</button></div>`).join('')
    :'<div style="color:var(--text-muted);font-size:11px">No generated files yet.</div>';

  try{
    const r=await fetch('/api/files');
    const d=await r.json();
    wsEl.innerHTML=(d.files||[]).slice(0,120).map(f=>`<div class="hub-item"><div class="left"><div class="name">${esc(f.path)}</div><div class="meta">${Number(f.size||0).toLocaleString()} chars</div></div><button onclick="openWorkspaceFile('${encodeURIComponent(f.path)}')">Open</button></div>`).join('')||'<div style="color:var(--text-muted);font-size:11px">No workspace files found.</div>';
  }catch{
    wsEl.innerHTML='<div style="color:var(--text-muted);font-size:11px">Could not load workspace files.</div>';
  }
}

async function openWorkspaceFile(encodedPath){
  const path=decodeURIComponent(encodedPath||'');
  if(!path)return;
  try{
    const r=await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    const d=await r.json();
    if(d.error){showToast(d.error,'error');return;}
    const title=path.split('/').pop()||path;
    const ext=(title.split('.').pop()||'').toLowerCase();
    const codeExts=new Set(['py','js','ts','tsx','jsx','css','html','json','md','yaml','yml','sql','sh','ps1','java','cpp','c','rs','go','php','rb']);
    openCanvas(d.content||'',title,codeExts.has(ext),{openPanel:true,sourcePath:path});
  }catch{
    showToast('Could not open file.','error');
  }
}

// ─── Image Gen ────────────────────────────────────
function openImageGen(){document.getElementById('imageModal').classList.add('open')}

async function genImage(){
  const p=document.getElementById('imgPrompt').value.trim();if(!p)return;
  const el=document.getElementById('imgResult');
  el.innerHTML='<div class="dots" style="justify-content:center;padding:12px"><span></span><span></span><span></span></div>';
  try{
    const r=await fetch('/api/generate-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:p})});
    const d=await r.json();
    el.innerHTML=d.image?`<img src="data:image/png;base64,${d.image}" style="max-width:100%;border-radius:var(--r-md);box-shadow:var(--shadow-md)">`:`<div style="color:var(--red);font-size:12px">${esc(d.error||'Failed')}</div>`;
  }catch(e){el.innerHTML=`<div style="color:var(--red);font-size:12px">${esc(e.message)}</div>`}
}

// ─── Modals ───────────────────────────────────────
function closeM(id){document.getElementById(id).classList.remove('open')}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.ov').forEach(o=>o.addEventListener('click',e=>{
    if(e.target===o&&o.id!=='onboardingModal')o.classList.remove('open');
  }));
});

// ─── Voice (stub) ─────────────────────────────────
function toggleTTS(){}
function speak(){}
function toggleMic(){}
function closeOrb(){}

// ─── Guest Limit (stub) ───────────────────────────
function showGuestLimit(){}
function toggleGuestAuthMode(){}
async function doGuestAuth(){}

// ─── Canvas ───────────────────────────────────────
let canvasIsCode=false;

function renderCanvasTabs(){
  const tabsEl=document.getElementById('canvasTabs');
  if(!tabsEl)return;
  tabsEl.innerHTML=canvasTabs.map(t=>`<button class="canvas-tab ${t.id===activeCanvasTabId?'active':''}" onclick="switchCanvasTab('${t.id}')">${esc(t.title||'Document')}</button>`).join('');
}

function switchCanvasTab(id){
  const tab=canvasTabs.find(t=>t.id===id);
  if(!tab)return;
  activeCanvasTabId=id;
  canvasIsCode=!!tab.isCode;
  const panel=document.getElementById('canvasPanel');
  const editor=document.getElementById('canvasEditor');
  const modeEl=document.getElementById('canvasMode');
  const titleEl=document.getElementById('canvasTitle');
  editor.value=tab.content||'';
  editor.className=tab.isCode?'canvas-editor code-mode':'canvas-editor';
  modeEl.textContent=tab.isCode?'CODE':'PROSE';
  titleEl.textContent=tab.title||'Document';
  renderCanvasTabs();
  updateCanvasStats();
  panel.classList.add('open');
  document.getElementById('canvasResizer').classList.add('visible');
  editor.focus();
  editor.oninput=()=>{
    tab.content=editor.value;
    updateCanvasStats();
  };
}

function openCanvas(content,title,isCode,opts={}){
  const options=opts&&typeof opts==='object'?opts:{};
  const sourcePath=options.sourcePath||'';
  const openPanel=options.openPanel!==false;
  let tab=canvasTabs.find(t=>sourcePath&&t.sourcePath===sourcePath);
  if(!tab){
    tab={
      id:'tab_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
      title:title||'Document',
      content:content||'',
      isCode:!!isCode,
      sourcePath,
    };
    canvasTabs.push(tab);
  }else{
    tab.title=title||tab.title;
    tab.content=content||tab.content;
    tab.isCode=!!isCode;
  }
  activeCanvasTabId=tab.id;
  if(openPanel)switchCanvasTab(tab.id);
  else renderCanvasTabs();
}

function closeCanvas(){
  const panel=document.getElementById('canvasPanel');
  const resizer=document.getElementById('canvasResizer');
  panel.classList.remove('open');
  panel.style.width='';
  resizer.classList.remove('visible');
}

// ─── Canvas drag-to-resize ────────────────────────
(function initCanvasResizer(){
  const resizer=document.getElementById('canvasResizer');
  if(!resizer)return;
  let dragging=false,startX=0,startW=0;
  resizer.addEventListener('mousedown',e=>{
    const panel=document.getElementById('canvasPanel');
    if(!panel.classList.contains('open'))return;
    dragging=true;startX=e.clientX;startW=panel.offsetWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const panel=document.getElementById('canvasPanel');
    const mainBody=panel.parentElement;
    const diff=startX-e.clientX;
    const newW=Math.min(Math.max(startW+diff,280),mainBody.offsetWidth*0.75);
    panel.style.width=newW+'px';
    panel.style.transition='none';
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging)return;
    dragging=false;
    const panel=document.getElementById('canvasPanel');
    const resizer=document.getElementById('canvasResizer');
    resizer.classList.remove('dragging');
    document.body.style.cursor='';
    document.body.style.userSelect='';
    panel.style.transition='';
  });
  // Touch support
  resizer.addEventListener('touchstart',e=>{
    const panel=document.getElementById('canvasPanel');
    if(!panel.classList.contains('open'))return;
    const t=e.touches[0];
    dragging=true;startX=t.clientX;startW=panel.offsetWidth;
    resizer.classList.add('dragging');
    e.preventDefault();
  },{passive:false});
  document.addEventListener('touchmove',e=>{
    if(!dragging)return;
    const panel=document.getElementById('canvasPanel');
    const mainBody=panel.parentElement;
    const t=e.touches[0];
    const diff=startX-t.clientX;
    const newW=Math.min(Math.max(startW+diff,280),mainBody.offsetWidth*0.75);
    panel.style.width=newW+'px';
    panel.style.transition='none';
  },{passive:false});
  document.addEventListener('touchend',()=>{
    if(!dragging)return;
    dragging=false;
    const panel=document.getElementById('canvasPanel');
    const resizer=document.getElementById('canvasResizer');
    resizer.classList.remove('dragging');
    panel.style.transition='';
  });
})();

function copyCanvas(){
  const text=document.getElementById('canvasEditor').value;
  navigator.clipboard.writeText(text).then(()=>showToast('Copied to clipboard','success'));
}

function downloadCanvas(){
  const text=document.getElementById('canvasEditor').value;
  const ext=canvasIsCode?'.txt':'.md';
  const title=(document.getElementById('canvasTitle').textContent||'document').replace(/[^a-zA-Z0-9]/g,'_');
  const blob=new Blob([text],{type:'text/plain'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=title+ext;a.click();
  URL.revokeObjectURL(a.href);
  showToast('Downloaded','success');
}

function updateCanvasStats(){
  const text=document.getElementById('canvasEditor').value;
  const lines=text.split('\n').length;
  const words=text.trim()?text.trim().split(/\s+/).length:0;
  document.getElementById('canvasLines').textContent=lines+' lines';
  document.getElementById('canvasChars').textContent=words+' words · '+text.length+' chars';
}

async function canvasAiEdit(){
  const input=document.getElementById('canvasAiInput');
  const instruction=input.value.trim();
  if(!instruction)return;
  const content=document.getElementById('canvasEditor').value;
  const language=canvasIsCode?(document.getElementById('canvasMode').textContent||'CODE'):'text';
  document.getElementById('canvasStatus').textContent='AI is editing...';
  input.value='';
  try{
    const r=await fetch('/api/canvas/apply',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content,instruction,language})});
    const d=await r.json();
    if(d.error){
      document.getElementById('canvasStatus').textContent='Edit failed: '+d.error;
      showToast(d.error,'error');return;
    }
    document.getElementById('canvasEditor').value=d.content||'';
    updateCanvasStats();
    document.getElementById('canvasStatus').textContent='Edit applied';
    showToast('Canvas updated by AI','success');
  }catch(e){
    document.getElementById('canvasStatus').textContent='Edit failed';
    showToast('AI edit failed','error');
  }
}

function sendCanvasToAI(){
  const content=document.getElementById('canvasEditor').value;
  if(!content.trim()){showToast('Canvas is empty','info');return;}
  const input=document.getElementById('msgInput');
  input.value='Here is my current canvas document. Please review and improve it:\n\n```\n'+content+'\n```';
  autoResize(input);input.focus();
  showToast('Canvas content added to chat','info');
}

function openMindMapCanvas(mindId){
  const item=mindMapStore.get(mindId);
  if(!item)return;
  const wrapped=`\`\`\`mermaid\n${item.source}\n\`\`\``;
  openCanvas(wrapped,item.title,true,{openPanel:true});
}

function mermaidSvgToPngDataUrl(svgEl,scale=2){
  return new Promise(resolve=>{
    try{
      const xml=new XMLSerializer().serializeToString(svgEl);
      const blob=new Blob([xml],{type:'image/svg+xml;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const img=new Image();
      img.onload=()=>{
        try{
          const w=Math.max(1,Math.ceil((svgEl.viewBox?.baseVal?.width||svgEl.clientWidth||svgEl.getBoundingClientRect().width||900)*scale));
          const h=Math.max(1,Math.ceil((svgEl.viewBox?.baseVal?.height||svgEl.clientHeight||svgEl.getBoundingClientRect().height||560)*scale));
          const canvas=document.createElement('canvas');
          canvas.width=w;canvas.height=h;
          const ctx=canvas.getContext('2d');
          ctx.fillStyle=getComputedStyle(document.body).getPropertyValue('--bg-surface')||'#121212';
          ctx.fillRect(0,0,w,h);
          ctx.drawImage(img,0,0,w,h);
          const dataUrl=canvas.toDataURL('image/png');
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        }catch{
          URL.revokeObjectURL(url);
          resolve('');
        }
      };
      img.onerror=()=>{URL.revokeObjectURL(url);resolve('');};
      img.src=url;
    }catch{
      resolve('');
    }
  });
}

async function enhanceMermaidDiagrams(){
  const containers=[...document.querySelectorAll('.mermaid-container')];
  for(const container of containers){
    // Check for mermaid parse errors and try to recover
    const errEl=container.querySelector('[id*="mermaid-error"],.error-icon,.error-text,p');
    const svg=container.querySelector('svg');
    if(!svg&&!container.dataset.recovered){
      // Mermaid failed to render — try re-rendering with aggressive sanitization
      container.dataset.recovered='1';
      const pre=container.querySelector('pre.mermaid');
      if(pre){
        const mindId=container.getAttribute('data-mindmap-id')||'';
        const mm=mindMapStore.get(mindId);
        if(mm?.source){
          let src=mm.source;
          // Aggressive cleanup: replace all special chars in non-keyword lines
          const lines=src.split('\n');
          const cleanLines=lines.map(l=>{
            if(/^\s*(mindmap|graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram|gantt|journey|pie)\b/i.test(l.trim()))return l;
            if(/^\s*$/.test(l))return l;
            // Keep indentation, strip all non-alpha from text
            const indent=l.match(/^(\s*)/)[1];
            let text=l.slice(indent.length);
            text=text.replace(/[^a-zA-Z0-9\s\-_.,&]/g,' ').replace(/\s+/g,' ').trim();
            return indent+text;
          });
          const cleanSrc=cleanLines.join('\n');
          try{
            const id='mm_retry_'+Date.now().toString(36);
            const{svg:svgStr}=await mermaid.render(id,cleanSrc);
            pre.innerHTML=svgStr;
            pre.classList.remove('mermaid');
            mm.source=cleanSrc;
          }catch(e2){
            // Still failed — show source as text fallback
            pre.innerHTML='<div style="padding:16px;font-size:12px;color:var(--text-muted);white-space:pre-wrap;font-family:var(--mono)">'+mm.source.replace(/</g,'&lt;')+'</div>';
            pre.classList.remove('mermaid');
          }
          continue;
        }
      }
    }
    if(!svg)continue;
    const mindId=container.getAttribute('data-mindmap-id')||'';
    const mm=mindMapStore.get(mindId);
    const png=await mermaidSvgToPngDataUrl(svg,2);
    if(!png)continue;
    let img=container.querySelector('img.mermaid-png');
    if(!img){
      img=document.createElement('img');
      img.className='mermaid-png';
      img.alt=(mm?.title||'Mind map');
      img.loading='lazy';
      if(mindId){
        img.style.cursor='pointer';
        img.onclick=()=>openMindMapCanvas(mindId);
      }
      container.appendChild(img);
    }
    img.src=png;
    svg.style.display='none';
    const dl=container.querySelector('.mm-download');
    if(dl){
      const fn=((mm?.title||'mind_map').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'mind_map')+'.png';
      dl.href=png;
      dl.download=fn;
      dl.onclick=null;
    }
  }
}

const PRODUCTIVITY_KEY='nexus_productivity_v1';

function loadProductivityState(){
  try{
    const raw=localStorage.getItem(PRODUCTIVITY_KEY);
    if(!raw)return {todos:[],visions:[]};
    const parsed=JSON.parse(raw);
    return {
      todos:Array.isArray(parsed.todos)?parsed.todos:[],
      visions:Array.isArray(parsed.visions)?parsed.visions:[],
    };
  }catch{
    return {todos:[],visions:[]};
  }
}

function saveProductivityState(state){
  localStorage.setItem(PRODUCTIVITY_KEY,JSON.stringify(state));
}

function openProductivityHub(){
  const modal=document.getElementById('productivityModal');
  if(!modal)return;
  modal.classList.add('open');
  renderProductivityHub();
}

function renderProductivityHub(){
  const state=loadProductivityState();
  const todoList=document.getElementById('todoList');
  const visionList=document.getElementById('visionList');
  if(todoList){
    todoList.innerHTML=state.todos.length
      ?state.todos.map(t=>`<div class="todo-item ${t.done?'done':''}"><button class="todo-check" onclick="toggleTodoItem('${t.id}')">${t.done?'✓':'○'}</button><div class="todo-text">${esc(t.text)}</div><button class="todo-del" onclick="deleteTodoItem('${t.id}')">✕</button></div>`).join('')
      :'<div class="todo-empty">No tasks yet. Add one to get moving.</div>';
  }
  if(visionList){
    visionList.innerHTML=state.visions.length
      ?state.visions.map(v=>`<div class="vision-item"><div class="vision-main"><div class="vision-title">${esc(v.title)}</div><div class="vision-meta">${esc(v.when||'No target date')}</div></div><div class="vision-actions"><button onclick="insertVisionPrompt('${v.id}')">Use</button><button onclick="deleteVisionItem('${v.id}')">✕</button></div></div>`).join('')
      :'<div class="todo-empty">No vision cards yet. Add your next milestone.</div>';
  }
}

function addTodoItem(){
  const input=document.getElementById('todoInput');
  const text=(input?.value||'').trim();
  if(!text)return;
  const state=loadProductivityState();
  state.todos.unshift({id:'t_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),text,done:false});
  saveProductivityState(state);
  input.value='';
  renderProductivityHub();
}

function toggleTodoItem(id){
  const state=loadProductivityState();
  const item=state.todos.find(t=>t.id===id);
  if(!item)return;
  item.done=!item.done;
  saveProductivityState(state);
  renderProductivityHub();
}

function deleteTodoItem(id){
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>t.id!==id);
  saveProductivityState(state);
  renderProductivityHub();
}

function addVisionItem(){
  const titleEl=document.getElementById('visionTitle');
  const whenEl=document.getElementById('visionWhen');
  const title=(titleEl?.value||'').trim();
  if(!title)return;
  const state=loadProductivityState();
  state.visions.unshift({id:'v_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),title,when:(whenEl?.value||'').trim()});
  saveProductivityState(state);
  titleEl.value='';
  if(whenEl)whenEl.value='';
  renderProductivityHub();
}

function deleteVisionItem(id){
  const state=loadProductivityState();
  state.visions=state.visions.filter(v=>v.id!==id);
  saveProductivityState(state);
  renderProductivityHub();
}

function insertVisionPrompt(id){
  const state=loadProductivityState();
  const card=state.visions.find(v=>v.id===id);
  if(!card)return;
  closeM('productivityModal');
  setDraft(`Help me create a concrete weekly execution plan for this vision: ${card.title}${card.when?` (target: ${card.when})`:''}`);
}

function insertProductivityPrompt(kind){
  closeM('productivityModal');
  const prompts={
    day:'Create my highest-impact plan for today with 3 priority tasks and time blocks.',
    week:'Build me a realistic weekly plan with milestones, focus sessions, and review checkpoints.',
    focus:'Set up a focused 50-minute sprint plan with a clear objective and done criteria.'
  };
  setDraft(prompts[kind]||prompts.day);
}

// ─── Mermaid ──────────────────────────────────────
function initMermaidTheme(){
  if(!window.mermaid)return;
  const light=theme==='light';
  mermaid.initialize({
    startOnLoad:false,
    theme:'base',
    flowchart:{curve:'basis',htmlLabels:true,nodeSpacing:48,rankSpacing:56,padding:18},
    mindmap:{padding:18,maxNodeWidth:260},
    themeVariables:light?{
      primaryColor:'#fff5ea',
      primaryTextColor:'#2a1f16',
      primaryBorderColor:'#ce976b',
      lineColor:'#ae7a4e',
      secondaryColor:'#f5e8da',
      tertiaryColor:'#ead8c6',
      fontSize:'15px',
      fontFamily:'Inter, Segoe UI, sans-serif',
      nodeBorder:'#ce976b',
      mainBkg:'#fff5ea',
      clusterBkg:'#f5e8da',
      edgeLabelBackground:'#f3e7d8',
    }:{
      primaryColor:'#2c2a35',
      primaryTextColor:'#f5eee8',
      primaryBorderColor:'#bf6b3a',
      lineColor:'#c3855f',
      secondaryColor:'#1f2530',
      tertiaryColor:'#342418',
      fontSize:'15px',
      fontFamily:'Inter, Segoe UI, sans-serif',
      nodeBorder:'#a17352',
      mainBkg:'#27232b',
      clusterBkg:'#1c212a',
      edgeLabelBackground:'#171615',
    }
  });
}

document.addEventListener('DOMContentLoaded',()=>{initMermaidTheme();});
document.addEventListener('DOMContentLoaded',()=>{renderProductivityHub();});

// ─── Keep-alive ping to prevent Render from sleeping while user is active ───
(function(){
  const PING_INTERVAL=4*60*1000; // every 4 minutes
  let pingTimer=null;
  function startPing(){
    if(pingTimer)return;
    pingTimer=setInterval(()=>{
      fetch('/api/ping').catch(()=>{});
    },PING_INTERVAL);
  }
  function stopPing(){
    if(pingTimer){clearInterval(pingTimer);pingTimer=null;}
  }
  // Ping while tab is visible
  startPing();
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden) stopPing();
    else startPing();
  });
})();