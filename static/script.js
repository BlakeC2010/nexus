// ─── State ────────────────────────────────────────
let curChat=null,allChats=[],ttsOn=false,recording=false,recognition=null,pendingFiles=[],pendingFolder='';
let _continueCount=0;const _MAX_CONTINUES=15;
let curUser=null,isGuest=false,authMode='login',theme='dark',googleClientId='';
let googleInitDone=false,thinkingEnabled=false,guestAuthMode='register';
let deepResearchDepth='standard';
let onboardingChecked=false;
let selectMode=false;
const selectedItems=new Set();
const _collapsedFolders=new Set();
const runningStreams=new Map();
const unreadChats=new Set();
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
const ONB_SKIP_KEY='gyro_onboarding_skipped';
const ONB_NO_REMIND_KEY='gyro_onboarding_no_remind';
const ONB_DISMISS_KEY='gyro_onboarding_reminder_dismissed';
const HOME_WIDGET_CACHE_KEY='gyro_home_widgets_cache_v1';
const CHAT_CACHE_KEY='gyro_recent_chats_v1';
const FOLDER_META_KEY='gyro_folder_meta_v1';
let homeWidgetRefreshTimer=null;
let homeWidgetRefreshInFlight=false;

function startThinkingPhrases(el){
  let i=0;
  if(_thinkInterval)clearInterval(_thinkInterval);
  _thinkInterval=setInterval(()=>{
    if(!el||!el.isConnected){clearInterval(_thinkInterval);_thinkInterval=null;return;}
    i=(i+1)%_thinkPhrases.length;
    el.style.transition='opacity .3s ease, transform .3s ease';
    el.style.opacity='0';
    el.style.transform='translateY(-3px)';
    setTimeout(()=>{
      if(!el.isConnected)return;
      el.textContent=' '+_thinkPhrases[i];
      el.style.transform='translateY(3px)';
      requestAnimationFrame(()=>{
        el.style.opacity='1';
        el.style.transform='translateY(0)';
      });
    },300);
  },2800);
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
  if(state){runningStreams.set(chatId,meta);}
  else{
    runningStreams.delete(chatId);
    // If this chat finished in the background, mark it unread
    if(chatId!==curChat)unreadChats.add(chatId);
    // Remove background generating indicator if visible
    const ind=document.getElementById('bg-gen-indicator');
    if(ind&&curChat===chatId)ind.remove();
  }
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
  const savedUid=localStorage.getItem('gyro_uid');
  const savedToken=localStorage.getItem('gyro_remember');
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
  const savedGid=localStorage.getItem('gyro_guest_id');
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
    else { _handleSessionLost(); return r; }
  }
  return r;
}

// ─── Session keep-alive ───────────────────────────
function _handleSessionLost(){
  showToast('Session expired. Please sign in again.','info');
  curUser=null; curChat=null;
  document.getElementById('appPage').classList.remove('visible');
  document.getElementById('loginPage').style.display='flex';
  initGoogleAuthUI();
}

// Ping the server periodically to keep the session cookie alive
setInterval(async()=>{
  if(!curUser) return;
  try{ await fetch('/api/auth/me'); }catch{}
}, 10*60*1000); // every 10 minutes

// On tab re-focus, verify the session is still valid
document.addEventListener('visibilitychange', async()=>{
  if(document.visibilityState!=='visible' || !curUser) return;
  try{
    const r=await fetch('/api/auth/me');
    const d=await r.json();
    if(!d.authenticated && !d.guest){
      const ok=await tryAutoResume();
      if(!ok) _handleSessionLost();
    }
  }catch{}
});

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded',async()=>{
  if(!localStorage.getItem('gyro_theme_override')){
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
    if(!localStorage.getItem('gyro_theme_override')){
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
  if(btn)btn.textContent=theme==='light'?'○':'●';
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
  localStorage.setItem('gyro_theme_override','1');
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
  allChats=loadCachedChats();
  hideSetupReminder();
  updateUserUI();
  if(!curChat){ loadWelcome(); }
  await ensureOAuthConfigLoaded();
  await loadModels();
  await refreshChats();
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  checkForUpdates();
  ensureOnboarding();
}

// ─── Changelog / Update Notification ──────────────
const LAST_SEEN_VERSION_KEY='gyro_last_seen_version';

async function checkForUpdates(){
  try{
    const r=await fetch('/api/changelog');
    if(!r.ok) return;
    const d=await r.json();
    const current=d.version;
    const lastSeen=localStorage.getItem(LAST_SEEN_VERSION_KEY);
    if(lastSeen===current) return;
    showChangelogModal(d.changelog, lastSeen, current);
  }catch{}
}

function showChangelogModal(changelog, lastSeen, currentVersion){
  const overlay=document.getElementById('changelogOverlay');
  const body=document.getElementById('clBody');
  const verEl=document.getElementById('clVersion');
  if(!overlay||!body) return;
  overlay._currentVersion=currentVersion;
  // Only show the most recent entry
  const latest=changelog[0];
  if(!latest) return;
  verEl.textContent=`v${latest.version} · ${_fmtChangelogDate(latest.date)}`;
  let html=`<div class="cl-entry cl-entry-new"><div class="cl-entry-head"><span class="cl-entry-ver">v${esc(latest.version)}</span><span class="cl-entry-title">${esc(latest.title)}</span><span class="cl-entry-date">${_fmtChangelogDate(latest.date)}</span></div><ul class="cl-changes">`;
  for(const c of latest.changes) html+=`<li>${esc(c)}</li>`;
  html+=`</ul></div>`;
  body.innerHTML=html;
  overlay.classList.add('open');
}

function dismissChangelog(){
  const overlay=document.getElementById('changelogOverlay');
  if(overlay._currentVersion){
    localStorage.setItem(LAST_SEEN_VERSION_KEY, overlay._currentVersion);
  }
  overlay.classList.remove('open');
}

function _versionCompare(a,b){
  const pa=a.split('.').map(Number), pb=b.split('.').map(Number);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    const na=pa[i]||0, nb=pb[i]||0;
    if(na>nb) return 1;
    if(na<nb) return -1;
  }
  return 0;
}

function _fmtChangelogDate(dateStr){
  try{
    const d=new Date(dateStr+'T00:00:00');
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  }catch{ return dateStr; }
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
    {icon:'→',label:'Plan my day',q:'Help me organize and prioritize everything on my plate today. Ask me 2 quick clarifying questions before building the plan.'},
    {icon:'→',label:'Help me write',q:'Help me write or polish something. Start by asking what audience, tone, and outcome I want.'},
    {icon:'→',label:'Brainstorm',q:'Brainstorm ideas with me for a project or problem. Push for novel options, then rank the top 3.'},
    {icon:'→',label:'Research & analyze',q:'Help me research this topic deeply. Outline the scope first, then suggest a strong investigation path.'}
  ];
}

function buildMasterPromptCards(){
  return getMasterPrompts().map(a=>`<div class="wl-action-card" onclick="fillMasterPrompt('${a.q.replace(/'/g,"\\'")}')"><span class="wl-ac-icon">${a.icon}</span><span class="wl-ac-label">${a.label}</span><span class="wl-ac-sub">Editable master prompt</span></div>`).join('');
}

function hasWidgetContent(w){
  const type=(w?.type||'focus').toLowerCase();
  if(type==='recent'||type==='todos'||type==='nudge'||type==='workflow')return Array.isArray(w.items)&&w.items.length>0;
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
  if(type==='todos'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>{
      const doneClass=i.done?'wl-todo-done':'';
      const check=i.done?'✓':'○';
      return `<div class="wl-todo-item ${doneClass}" data-todo-id="${esc(i.id||'')}">`
        +`<button class="wl-todo-check" onclick="event.stopPropagation();toggleHomeTodo('${esc(i.id||'')}')">${check}</button>`
        +`<span class="wl-todo-text">${esc(i.text||'')}</span>`
        +`<button class="wl-todo-del" onclick="event.stopPropagation();deleteHomeTodo('${esc(i.id||'')}')" title="Delete">✕</button>`
        +`</div>`;
    }).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-todo-list">${body}</div></div>`;
  }
  if(type==='nudge'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const catIcons={'stale_chat':'⏸','task_overload':'📋','scope_creep':'📈','stalled_project':'🔄','deadline_soon':'⏰','resource_spread':'🎯','status_friction':'⚡','no_focus':'🧭'};
    const body=items.map(i=>{
      const icon=catIcons[i.category]||'●';
      const actionAttr=i.action?`data-nudge-action='${esc(JSON.stringify(i.action))}'`:'';
      return `<div class="wl-nudge-item" ${actionAttr}>`
        +`<span class="wl-nudge-icon">${icon}</span>`
        +`<div class="wl-nudge-body">`
        +`<div class="wl-nudge-msg">${esc(i.message||'')}</div>`
        +`<div class="wl-nudge-step">${esc(i.next_step||'')}</div>`
        +`</div>`
        +`<button class="wl-nudge-act" onclick="event.stopPropagation();handleNudgeAction(this)">Go</button>`
        +`</div>`;
    }).join('');
    return `<div class="${cls} wl-nudge-widget"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-nudge-list">${body}</div></div>`;
  }
  if(type==='vision'){
    const text=(w?.text||'').trim();
    if(!text)return'';
    const meta=w?.meta?`<div class="wl-vision-meta">${esc(w.meta)}</div>`:'';
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-vision-main">${esc(text)}</div>${meta}</div>`;
  }
  if(type==='crossref'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>`<div class="wl-crossref-item"><div class="wl-crossref-summary">${esc(i.summary||'')}</div></div>`).join('');
    return `<div class="${cls}"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-crossref-list">${body}</div></div>`;
  }
  if(type==='workflow'){
    const items=Array.isArray(w.items)?w.items:[];
    if(!items.length)return'';
    const body=items.map(i=>{
      const actionAttr=i.action?`data-nudge-action='${esc(JSON.stringify(i.action))}'`:'';
      return `<div class="wl-nudge-item" ${actionAttr}>`
        +`<span class="wl-nudge-icon">→</span>`
        +`<div class="wl-nudge-body">`
        +`<div class="wl-nudge-msg">${esc(i.detected||'')}</div>`
        +`<div class="wl-nudge-step">${esc(i.suggestion||'')}</div>`
        +`</div>`
        +(i.action?`<button class="wl-nudge-act" onclick="event.stopPropagation();handleNudgeAction(this)">Go</button>`:'')
        +`</div>`;
    }).join('');
    return `<div class="${cls} wl-nudge-widget"><div class="wl-widget-hd">${title}</div>${subtitle}<div class="wl-nudge-list">${body}</div></div>`;
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
  const chats=(allChats||[]).slice(0,4);
  const pool=[];

  // Proactive friction detection — nudges (highest priority)
  const nudges=_detectClientFriction();
  if(nudges.length){
    pool.push({
      type:'nudge',
      size:'medium',
      title:'Needs your attention',
      subtitle:`${nudges.length} item${nudges.length!==1?'s':''}`,
      items:nudges,
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
  if(chats.length){
    pool.push({
      type:'recent',
      size:'medium',
      title:'Recent chats',
      items:chats.map(c=>({id:c.id,title:c.title||'Untitled'})),
    });
  }

  return {
    heading:'What would you like to work on today?',
    widgets:pool.slice(0,3),
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
  const rawName=(curUser?.name||'').split(' ')[0]||'';
  const uname=(rawName==='Guest'&&isGuest)?'':rawName;
  const namePart=uname?`, ${uname}`:'';
  const period=hour<5?'late night':hour<12?'morning':hour<17?'afternoon':hour<21?'evening':'late night';
  const presets={
    'late night':[
      `Burning the midnight oil${namePart}?`,
      `Late-night focus${namePart}?`,
      `Quiet hours, clear mind${namePart}.`,
      `The world sleeps${namePart}. You build.`,
      `Night owl mode activated${namePart}.`,
      `Still going strong${namePart}? 🌙`,
      `Deep into the night${namePart}.`,
      `Midnight clarity${namePart}.`,
      `The best ideas come late${namePart}.`,
      `No distractions now${namePart}.`,
    ],
    morning:[
      `Early start today${namePart}?`,
      `Morning focus, steady pace${namePart}.`,
      `Fresh morning energy${namePart}.`,
      `New day, new momentum${namePart}.`,
      `Rise and build${namePart}. ☀️`,
      `Morning brain is the best brain${namePart}.`,
      `Let's make today count${namePart}.`,
      `Good morning${namePart}. What's the plan?`,
      `The day is yours${namePart}.`,
      `Coffee and ideas${namePart}? ☕`,
      `Starting fresh${namePart}.`,
      `Clear mind, full day ahead${namePart}.`,
    ],
    afternoon:[
      `Afternoon rhythm holding up${namePart}?`,
      `Midday focus check${namePart}.`,
      `Keeping momentum this afternoon${namePart}?`,
      `Halfway through the day${namePart}.`,
      `Afternoon push${namePart}. Let's go.`,
      `Post-lunch productivity${namePart}? 🚀`,
      `Still crushing it${namePart}.`,
      `The afternoon stretch${namePart}.`,
      `Second wind kicking in${namePart}?`,
      `Keep the energy up${namePart}.`,
    ],
    evening:[
      `Evening stretch ahead${namePart}.`,
      `Winding down or diving in${namePart}?`,
      `Golden hour thoughts${namePart}.`,
      `Evening mode${namePart}. Time to reflect or create.`,
      `Wrapping up the day${namePart}?`,
      `One more thing before tonight${namePart}?`,
      `Good evening${namePart}. What's on your mind?`,
      `The quiet part of the day${namePart}. 🌅`,
      `End-of-day clarity${namePart}.`,
      `Evening glow, fresh perspective${namePart}.`,
    ],
  };
  const options=presets[period]||[`Ready when you are${namePart}.`];
  return options[Math.floor(Math.random()*options.length)];
}

async function loadWelcome(force=false){
  const area=document.getElementById('chatArea');
  if(curChat&&!force)return;
  _activeFolderView=null;
  const greeting=getLocalTimeGreeting();
  const instantPlan=buildInstantHomePlan(greeting);
  area.innerHTML=getWelcomeHTML(greeting,instantPlan);
}

function goHome(){
  curChat=null;
  _activeFolderView=null;
  document.getElementById('topTitle').textContent='New Chat';
  loadWelcome(true);
  renderChatList();
}

/* ─── Folder Meta (emoji, color) stored in localStorage ─── */
function _loadFolderMeta(){
  try{return JSON.parse(localStorage.getItem(FOLDER_META_KEY)||'{}');}catch{return {};}
}
function _saveFolderMeta(meta){
  try{localStorage.setItem(FOLDER_META_KEY,JSON.stringify(meta||{}));}catch{}
}
function getFolderMeta(folder){
  const all=_loadFolderMeta();
  return all[folder]||{};
}
function setFolderMeta(folder,patch){
  const all=_loadFolderMeta();
  all[folder]={...(all[folder]||{}),...patch};
  _saveFolderMeta(all);
}
function renameFolderMeta(oldName,newName){
  const all=_loadFolderMeta();
  if(all[oldName]){all[newName]=all[oldName];delete all[oldName];_saveFolderMeta(all);}
}
function deleteFolderMeta(folder){
  const all=_loadFolderMeta();
  delete all[folder];
  _saveFolderMeta(all);
}
function getFolderIcon(folder){
  const m=getFolderMeta(folder);
  return m.emoji||'📁';
}
function getFolderColor(folder){
  const m=getFolderMeta(folder);
  return m.color||'';
}

let _activeFolderView=null;

function openFolderView(folder){
  _activeFolderView=folder;
  curChat=null;
  const area=document.getElementById('chatArea');
  const chats=allChats.filter(c=>c.folder===folder);
  document.getElementById('topTitle').textContent=folder;
  const meta=getFolderMeta(folder);
  const fIcon=meta.emoji||'📁';
  const fColor=meta.color||'var(--accent)';
  const chatListHtml=chats.length?chats.map(c=>{
    const preview=c.messages?.length?`${c.messages.length} messages`:'Empty chat';
    return `<div class="fv-chat" onclick="openChat('${esc(c.id)}')">`
      +`<span class="fv-chat-icon">💬</span>`
      +`<div class="fv-chat-info"><div class="fv-chat-title">${esc(c.title||'Untitled')}</div><div class="fv-chat-meta">${preview}</div></div>`
      +`<span class="fv-chat-arrow">→</span></div>`;
  }).join('')
    :'<div class="fv-empty">No chats yet. Start one below.</div>';
  area.innerHTML=`<div class="folder-view">
    <div class="fv-hero">
      <div class="fv-hero-icon" style="background:${fColor}20;color:${fColor}">${fIcon}</div>
      <h1 class="fv-title">${esc(folder)}</h1>
      <p class="fv-subtitle">${chats.length} chat${chats.length!==1?'s':''}</p>
    </div>
    <div class="fv-actions">
      <button class="fv-action-btn fv-action-primary" onclick="createChat('${esc(folder).replace(/'/g,"\\'")}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Chat
      </button>
      <button class="fv-action-btn" onclick="customizeFolder('${esc(folder).replace(/'/g,"\\'")}')">🎨 Customize</button>
      <button class="fv-action-btn" onclick="renameFolderFromView('${esc(folder).replace(/'/g,"\\'")}')">✏️ Rename</button>
      <button class="fv-action-btn fv-action-danger" onclick="deleteFolderAndChats('${esc(folder).replace(/'/g,"\\'")}')">🗑 Delete</button>
    </div>
    <div class="fv-chat-list">${chatListHtml}</div>
  </div>`;
  renderChatList();
}

async function renameFolderFromView(oldName){
  const next=await _dlg({title:'Rename folder',msg:'',icon:'▸',iconType:'info',inputLabel:'New name',inputDefault:oldName,inputPlaceholder:'Folder name',confirmText:'Rename',cancelText:'Cancel'});
  if(!next?.trim()||next.trim()===oldName)return;
  const newName=next.trim();
  renameFolderMeta(oldName,newName);
  const chats=allChats.filter(c=>c.folder===oldName);
  for(const c of chats){
    await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:newName})});
  }
  await refreshChats();
  openFolderView(newName);
  showToast('Folder renamed.','success');
}

async function customizeFolder(folder){
  const meta=getFolderMeta(folder);
  const emojis=['📁','💼','🎯','🚀','💡','📝','🎨','🔬','📚','🎮','🏠','❤️','⭐','🔥','🌟','💎','🎵','📸','🌍','🧪','✨','🤖','🛠️','📊',''];
  const colors=['','#bf6b3a','#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722'];
  const colorNames=['Default','Orange','Red','Amber','Yellow','Green','Teal','Blue','Purple','Pink','Cyan','Deep Orange'];
  const curEmoji=meta.emoji||'📁';
  const curColor=meta.color||'';
  const emojiGrid=emojis.map(e=>{
    const label=e||'None';
    const sel=e===curEmoji||(e===''&&!curEmoji)?' fv-cust-sel':'';
    return `<button class="fv-cust-btn${sel}" onclick="this.closest('.fv-cust-popup').dataset.emoji='${e}';this.closest('.fv-cust-grid').querySelectorAll('.fv-cust-btn').forEach(b=>b.classList.remove('fv-cust-sel'));this.classList.add('fv-cust-sel')">${label}</button>`;
  }).join('');
  const colorGrid=colors.map((c,i)=>{
    const sel=c===curColor||(c===''&&!curColor)?' fv-cust-sel':'';
    const bg=c||'var(--text-muted)';
    return `<button class="fv-cust-color${sel}" style="background:${bg}" title="${colorNames[i]}" onclick="this.closest('.fv-cust-popup').dataset.color='${c}';this.closest('.fv-cust-grid').querySelectorAll('.fv-cust-color').forEach(b=>b.classList.remove('fv-cust-sel'));this.classList.add('fv-cust-sel')"></button>`;
  }).join('');

  const popup=document.createElement('div');
  popup.className='fv-cust-popup';
  popup.dataset.emoji=curEmoji;
  popup.dataset.color=curColor;
  popup.innerHTML=`
    <div class="fv-cust-overlay" onclick="this.parentElement.remove()"></div>
    <div class="fv-cust-modal">
      <h3>Customize "${esc(folder)}"</h3>
      <div class="fv-cust-section">
        <label>Icon</label>
        <div class="fv-cust-grid">${emojiGrid}</div>
      </div>
      <div class="fv-cust-section">
        <label>Color</label>
        <div class="fv-cust-grid">${colorGrid}</div>
      </div>
      <div class="fv-cust-footer">
        <button class="fv-cust-cancel" onclick="this.closest('.fv-cust-popup').remove()">Cancel</button>
        <button class="fv-cust-save" onclick="saveFolderCustomize(this)">Save</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function saveFolderCustomize(btn){
  const popup=btn.closest('.fv-cust-popup');
  const folder=_activeFolderView;
  if(!folder){popup.remove();return;}
  const emoji=popup.dataset.emoji||'';
  const color=popup.dataset.color||'';
  setFolderMeta(folder,{emoji,color});
  popup.remove();
  renderChatList();
  openFolderView(folder);
  showToast('Folder customized.','success');
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
  };
  try{
    const r=await fetch('/api/home-widgets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json();
    return d||{};
  }catch{
    return {};
  }
}

async function fillMasterPrompt(text){
  const normalized=normalizeMasterPrompt(text);
  const input=document.getElementById('msgInput');
  if(!input)return;
  input.value=normalized;
  autoResize(input);
  input.focus();
}

function updateUserUI(){
  if(!curUser)return;
  document.getElementById('userName').textContent=curUser.name||'User';
  document.getElementById('userEmail').textContent=curUser.email||'';
  document.getElementById('userAvatar').textContent=(curUser.name||'U')[0].toUpperCase();
  const planEl=document.getElementById('userPlan');
  if(planEl){
    const plan=curUser.plan||'free';
    const labels={guest:'Guest',free:'Free',pro:'Pro',max:'Max',dev:'DEV'};
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
      localStorage.setItem('gyro_uid',d.user.id);
      localStorage.setItem('gyro_remember',d.remember_token);
      localStorage.removeItem('gyro_guest_id');
    }
    theme=d.user.theme||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
    applyTheme(false); onboardingChecked=false; showApp();
  }catch(e){document.getElementById('loginErr').textContent='Google auth failed'}
}

async function guestLogin(){
  try{
    const prevGid=localStorage.getItem('gyro_guest_id')||'';
    const r=await fetch('/api/auth/guest',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({guest_id:prevGid})});
    const d=await r.json();
    if(d.ok){
      isGuest=true;curUser={name:'Guest',email:'',plan:'guest'};
      if(d.guest_id) localStorage.setItem('gyro_guest_id',d.guest_id);
      showApp();
    }
    else document.getElementById('loginErr').textContent=d.error||'Guest login failed';
  }catch(e){document.getElementById('loginErr').textContent='Guest login failed'}
}

async function signOut(){
  const ok=await _dlg({title:'Sign out',msg:'Are you sure you want to sign out of gyro?',icon:'⏻',iconType:'warn',confirmText:'Sign out',cancelText:'Cancel'});
  if(!ok)return;
  await fetch('/api/auth/logout',{method:'POST'});
  localStorage.removeItem('gyro_uid');
  localStorage.removeItem('gyro_remember');
  localStorage.removeItem('gyro_guest_id');
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
    showToast('All set! gyro is personalized for you.','success');
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
  // Include empty folders from meta
  const folderMeta=_loadFolderMeta();
  for(const fld of Object.keys(folderMeta)){
    if(fld&&!grouped[fld])grouped[fld]=[];
  }
  let html='';const seen=new Set();
  for(const fld of ['',...Object.keys(grouped).filter(f=>f).sort()]){
    if(seen.has(fld)||!grouped[fld])continue;seen.add(fld);
    if(fld){
      const fldSel=selectMode&&_isFolderSelected(fld)?' selected':'';
      const chatCount=grouped[fld].length;
      const isCollapsed=_collapsedFolders.has(fld);
      const fIcon=getFolderIcon(fld);
      const fColor=getFolderColor(fld);
      const colorStyle=fColor?` style="color:${fColor}"`:'';
      html+=`<div class="sb-folder${fldSel}${isCollapsed?' collapsed':''}" data-folder="${esc(fld)}" onclick="openFolderView('${esc(fld).replace(/'/g,"\\'")}')">`;  
      if(selectMode)html+=`<input type="checkbox" class="sb-sel-cb" ${_isFolderSelected(fld)?'checked':''} onclick="event.stopPropagation();toggleSelectFolder('${esc(fld)}')">`;
      html+=`<span class="sf-arrow" onclick="event.stopPropagation();toggleFolderCollapse('${esc(fld)}')">${isCollapsed?'▸':'▾'}</span>`;
      html+=`<span class="sf-icon"${colorStyle}>${fIcon}</span>`;
      html+=`<span class="sf-label">${esc(fld)}</span>`;
      html+=`<span class="sf-count">${chatCount}</span>`;
      html+=`<button class="sf-dots" onclick="event.stopPropagation();toggleFolderMenu(this,'${esc(fld)}')" title="Folder options">⋮</button></div>`;
      if(isCollapsed) continue;
    }
    for(const c of grouped[fld]){
      const a=c.id===curChat?' active':'';
      const g=isChatRunning(c.id)?' generating':'';
      const u=unreadChats.has(c.id)?' unread':'';
      const sel=selectMode&&selectedItems.has(c.id)?' selected':'';
      html+=`<div class="sb-chat${a}${g}${u}${sel}" onclick="${selectMode?`toggleSelectChat('${c.id}')`:"openChat('"+c.id+"')"}">`;
      if(selectMode)html+=`<input type="checkbox" class="sb-sel-cb" ${selectedItems.has(c.id)?'checked':''} onclick="event.stopPropagation();toggleSelectChat('${c.id}')">`;
      html+=`<span class="ct">${esc(c.title)}</span><button class="cd" onclick="event.stopPropagation();showMoveMenu(this,'${c.id}')" title="Move to folder">📁</button><button class="cd" onclick="event.stopPropagation();renameChat('${c.id}')" title="Rename">✎</button><button class="cd" onclick="event.stopPropagation();delChat('${c.id}')">✕</button></div>`;
    }
  }
  el.innerHTML=html||'<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:11px;line-height:1.7">No chats yet.<br>Start a conversation to see it here.</div>';
  // Update select bar count
  const selBar=document.getElementById('selectBar');
  if(selBar){
    const cnt=selectedItems.size;
    document.getElementById('selCount').textContent=cnt?`${cnt} selected`:'None selected';
  }
}

function filterChats(){renderChatList(document.getElementById('chatSearch').value)}

async function renameChat(id){
  const chat=allChats.find(c=>c.id===id);
  const next=await _dlg({title:'Rename chat',msg:'',icon:'▸',iconType:'info',inputLabel:'New title',inputDefault:chat?.title||'',inputPlaceholder:'Chat title…',confirmText:'Rename',cancelText:'Cancel'});
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
  const n=await _dlg({title:'New folder',msg:'',icon:'▸',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create',cancelText:'Cancel'});
  if(!n?.trim())return;
  const name=n.trim();
  // Just create the folder entry in meta and add one empty chat to register the folder on the server
  // Actually - we just need at least one chat with that folder. Create no chat; use a placeholder approach.
  // To make the folder appear even with 0 chats, we store it in folderMeta and render it in sidebar.
  setFolderMeta(name,{emoji:'📁',color:''});
  renderChatList();
  openFolderView(name);
  showToast('Folder created.','success');
}
function toggleFolderCollapse(folder){
  if(_collapsedFolders.has(folder))_collapsedFolders.delete(folder);
  else _collapsedFolders.add(folder);
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function toggleFolderMenu(btn,folder){
  const existing=document.querySelector('.sf-menu');
  if(existing){existing.remove();return;}
  const menu=document.createElement('div');
  menu.className='sf-menu';
  menu.innerHTML=`<button onclick="renameFolderFromMenu('${folder.replace(/'/g,"\\'")}')">Rename</button><button onclick="customizeFolder('${folder.replace(/'/g,"\\'")}')">Customize</button><button onclick="deleteFolderFromMenu('${folder.replace(/'/g,"\\'")}')">Remove folder</button><button onclick="deleteFolderAndChats('${folder.replace(/'/g,"\\'")}')">Delete folder & chats</button>`;
  btn.parentElement.style.position='relative';
  btn.parentElement.appendChild(menu);
  const close=e=>{if(!menu.contains(e.target)&&e.target!==btn){menu.remove();document.removeEventListener('click',close)}};
  setTimeout(()=>document.addEventListener('click',close),0);
}
function showMoveMenu(btn,chatId){
  const existing=document.querySelector('.sf-menu');
  if(existing){existing.remove();return;}
  const chat=allChats.find(c=>c.id===chatId);
  const curFolder=chat?.folder||'';
  const folders=[...new Set([...allChats.map(c=>c.folder).filter(f=>f),...Object.keys(_loadFolderMeta())])].sort();
  const menu=document.createElement('div');
  menu.className='sf-menu';
  let items='';
  for(const f of folders){
    if(f===curFolder) continue;
    const safe=f.replace(/'/g,"\\'").replace(/</g,'&lt;');
    items+=`<button onclick="moveChat('${chatId}','${safe}')">📁 ${esc(f)}</button>`;
  }
  if(curFolder) items+=`<button onclick="moveChat('${chatId}','')">🚫 Remove from folder</button>`;
  if(!items) items='<div style="padding:8px 12px;color:var(--text-muted);font-size:11px">No folders yet</div>';
  menu.innerHTML=items;
  btn.closest('.sb-chat').style.position='relative';
  btn.closest('.sb-chat').appendChild(menu);
  const close=e=>{if(!menu.contains(e.target)&&e.target!==btn){menu.remove();document.removeEventListener('click',close)}};
  setTimeout(()=>document.addEventListener('click',close),0);
}
async function moveChat(chatId,folder){
  document.querySelector('.sf-menu')?.remove();
  await fetch(`/api/chats/${chatId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  await refreshChats();
  if(_activeFolderView) openFolderView(_activeFolderView);
  showToast(folder?`Moved to ${folder}.`:'Removed from folder.','success');
}
async function renameFolderFromMenu(oldName){
  document.querySelector('.sf-menu')?.remove();
  const next=await _dlg({title:'Rename folder',msg:'',icon:'▸',iconType:'info',inputLabel:'New name',inputDefault:oldName,inputPlaceholder:'Folder name',confirmText:'Rename',cancelText:'Cancel'});
  if(!next?.trim()||next.trim()===oldName)return;
  renameFolderMeta(oldName,next.trim());
  const chats=allChats.filter(c=>c.folder===oldName);
  for(const c of chats){await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:next.trim()})});}
  await refreshChats();showToast('Folder renamed.','success');
}
async function openFolderSettings(folder){
  document.querySelector('.sf-menu')?.remove();
  const chats=allChats.filter(c=>c.folder===folder);
  if(!chats.length){showToast('No chats in folder.','info');return;}
  curChat=chats[0].id;
  openChatDrawer();
}
async function deleteFolderFromMenu(folder){
  document.querySelector('.sf-menu')?.remove();
  const ok=await _dlg({title:'Remove folder',msg:'Chats will be moved out of the folder, not deleted.',icon:'▸',iconType:'danger',confirmText:'Remove folder',cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  const chats=allChats.filter(c=>c.folder===folder);
  for(const c of chats){await fetch(`/api/chats/${c.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:''})});}
  deleteFolderMeta(folder);
  await refreshChats();
  if(_activeFolderView===folder){goHome();}
  showToast('Folder removed.','success');
}

async function deleteFolderAndChats(folder){
  document.querySelector('.sf-menu')?.remove();
  const chats=allChats.filter(c=>c.folder===folder);
  const ok=await _dlg({title:'Delete folder & all chats',msg:`This will permanently delete the folder "${folder}" and ${chats.length} chat${chats.length!==1?'s':''} inside it.`,icon:'🔥',iconType:'danger',confirmText:`Delete ${chats.length} chat${chats.length!==1?'s':''}`,cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  const ids=chats.map(c=>c.id);
  if(ids.length){
    await fetch('/api/chats/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_ids:ids})});
  }
  deleteFolderMeta(folder);
  if(ids.includes(curChat)||_activeFolderView===folder){
    goHome();
  }
  await refreshChats();showToast(`Folder "${folder}" deleted.`,'success');
}

// ─── Multi-Select Mode ────────────────────────────
function toggleSelectMode(){
  selectMode=!selectMode;
  selectedItems.clear();
  const bar=document.getElementById('selectBar');
  if(bar)bar.style.display=selectMode?'flex':'none';
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function _isFolderSelected(folder){
  const chats=allChats.filter(c=>c.folder===folder);
  return chats.length>0&&chats.every(c=>selectedItems.has(c.id));
}
function toggleSelectChat(id){
  if(selectedItems.has(id))selectedItems.delete(id); else selectedItems.add(id);
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function toggleSelectFolder(folder){
  const chats=allChats.filter(c=>c.folder===folder);
  const allSelected=chats.every(c=>selectedItems.has(c.id));
  for(const c of chats){
    if(allSelected)selectedItems.delete(c.id); else selectedItems.add(c.id);
  }
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function selectAllChats(){
  for(const c of allChats)selectedItems.add(c.id);
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
function deselectAllChats(){
  selectedItems.clear();
  renderChatList(document.getElementById('chatSearch')?.value||'');
}
async function deleteSelectedChats(){
  if(!selectedItems.size){showToast('Nothing selected.','info');return;}
  const count=selectedItems.size;
  const ok=await _dlg({title:`Delete ${count} chat${count!==1?'s':''}?`,msg:`This will permanently delete ${count} selected chat${count!==1?'s':''}.`,icon:'🔥',iconType:'danger',confirmText:`Delete ${count}`,cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  const ids=[...selectedItems];
  await fetch('/api/chats/bulk-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_ids:ids})});
  if(ids.includes(curChat)){
    goHome();
  } else if(!curChat){
    loadWelcome(true);
  }
  selectedItems.clear();
  await refreshChats();
  showToast(`${count} chat${count!==1?'s':''} deleted.`,'success');
}

// ─── Smart Home Widgets (async) ─────────────────
async function _loadSmartWidgets(){
  try{
    const [crRes, wfRes]=await Promise.all([
      fetch('/api/cross-references').then(r=>r.ok?r.json():null).catch(()=>null),
      fetch('/api/workflow-patterns').then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    const grid=document.querySelector('.wl-grid');
    if(!grid)return;
    // Add cross-reference widget if data exists
    if(crRes?.references?.length){
      const w={type:'crossref',size:'medium',title:'Cross-References',subtitle:`${crRes.references.length} connection${crRes.references.length!==1?'s':''}`,items:crRes.references.slice(0,5)};
      const html=renderHomeWidget(w);
      if(html)grid.insertAdjacentHTML('beforeend',html);
    }
    // Add workflow pattern widget if data exists
    if(wfRes?.patterns?.length){
      const w={type:'workflow',size:'medium',title:'Workflow Insights',subtitle:'Based on your recent activity',items:wfRes.patterns};
      const html=renderHomeWidget(w);
      if(html)grid.insertAdjacentHTML('beforeend',html);
    }
  }catch{}
}

async function openChat(id){
  if(curChat===id) return;
  _activeFolderView=null;
  curChat=id;
  unreadChats.delete(id);
  // Auto-close canvas when switching chats
  closeCanvas();
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
  _suppressCanvasAutoOpen=true;
  if(chat.messages?.length){
    for(const m of chat.messages){
      if(m.role==='user')addMsg('user',m.text,[],m);
      else addMsg('kairo',m.text,m.files_modified||[],m);
    }
    _suppressCanvasAutoOpen=false;
    setTimeout(()=>{
      try{
        Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams());
      }catch(e){
        console.log('Mermaid re-render:',e);
      }
    },200);
  }else{
    _suppressCanvasAutoOpen=false;
    loadWelcome(true);
  }
  // If this chat has an active stream, show a generating indicator
  if(isChatRunning(id)){
    const genDiv=document.createElement('div');
    genDiv.className='msg kairo';
    genDiv.id='bg-gen-indicator';
    genDiv.innerHTML='<div class="lbl">gyro</div><div class="msg-content"><div class="think-active"><div class="dots"><span></span><span></span><span></span></div><span> Generating...</span></div></div>';
    area.appendChild(genDiv);
    area.scrollTop=area.scrollHeight;
  }
  renderChatList(document.getElementById('chatSearch').value);
  updateComposerBusyUI();
  document.getElementById('msgInput').focus();
  setStatus('Chat loaded. Continue or ask for a summary.');
}

async function delChat(id){
  const ok=await _dlg({title:'Delete chat',msg:'This chat will be permanently deleted.',icon:'▸',iconType:'danger',confirmText:'Delete',cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  try{
    const run=runningStreams.get(id);
    if(run?.controller)run.controller.abort();
    runningStreams.delete(id);
    await fetch(`/api/chats/${id}`,{method:'DELETE'});
    await refreshChats();
    if(curChat===id){
      goHome();
    } else if(_activeFolderView){
      // Re-render folder view to update the list
      openFolderView(_activeFolderView);
    } else if(!curChat){
      // On homepage — refresh the widget
      loadWelcome(true);
    }
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
      const lockIcon=locked?'<span class="lock-icon">•</span>':'';
      opt.innerHTML=`${logoImg(m.provider)} <span>${esc(m.label)}</span>${badgeHTML}${lockIcon}`;
      opt.onclick=()=>{
        if(locked){showUpgradeForModel(m);return;}
        if(unavailable){showToast(m.locked_reason||'Model unavailable','error');return;}
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
  document.getElementById('upgradeModalSubtitle').textContent='Manage your gyro plan.';
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
    showToast('Plan purchasing is not available yet. Use the Developer plan for full access.','info');
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
  const thinkBadge=document.getElementById('thinkMenuBadge');
  if(thinkItem)thinkItem.classList.toggle('active',thinkingEnabled);
  if(thinkBadge)thinkBadge.textContent=thinkingEnabled?'ON':'OFF';
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
    const t=f.mime?.startsWith('image/')&&f.data?`<img src="data:${f.mime};base64,${f.data}">`:'▪';
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

let activeTools=new Set();

function activateTool(tool){
  if(tool==='imagegen'){showToast('Coming soon!','info');return;}
  if(activeTools.has(tool)){
    activeTools.delete(tool);
    showToast(`${tool.charAt(0).toUpperCase()+tool.slice(1)} tool deactivated`,'info');
  } else {
    activeTools.add(tool);
    showToast(`${tool.charAt(0).toUpperCase()+tool.slice(1)} tool activated`,'success');
  }
  renderToolBadges();
  document.getElementById('msgInput').focus();
}

function renderToolBadges(){
  let wrap=document.getElementById('toolBadges');
  if(!wrap){
    const inputRow=document.querySelector('.input-row');
    if(!inputRow)return;
    wrap=document.createElement('div');
    wrap.id='toolBadges';
    wrap.className='tool-badges';
    inputRow.parentElement.insertBefore(wrap,inputRow);
  }
  if(!activeTools.size){wrap.style.display='none';return;}
  wrap.style.display='flex';
  const names={canvas:'Canvas',search:'Web Search',mindmap:'Mind Map',research:'Deep Research',summarize:'Summarize',code:'Code Execution'};
  wrap.innerHTML=[...activeTools].map(t=>`<span class="tool-badge" onclick="activateTool('${t}')">${names[t]||t} <span class="tb-x">×</span></span>`).join('');
}

function toggleResearch(){
  activateTool('research');
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
  if(!activeTools.has('research')) activateTool('research');
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
  if(!activeTools.has('research')){
    activateTool('research');
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

  const stepNames=['Plan','Scout','Read','Deepen','Synthesize','Verify','Export'];
  const stepIcons=['1','2','3','4','5','6','7'];
  let currentPct=0, currentStep=0, lastMessage='Preparing research pipeline...';
  let wasCancelled=false;
  let researchCompleted=false;
  let finalReport='';
  let finalSources=[];
  let finalQuery=query;

  // Build initial progress card HTML once
  const stepsInitHtml=stepNames.map((name,i)=>{
    return `<div class="research-step" data-rs="${i}"><div class="research-step-dot">${i+1}</div><div class="research-step-label">${name}</div></div>`;
  }).join('');
  contentEl.innerHTML=`
    <div class="research-badge">🔬 Deep Research · ${esc(depth)}</div>
    <div class="research-progress" id="_rp">
      <div class="research-progress-header">
        <span class="research-progress-title" id="_rpTitle">Plan...</span>
        <span class="research-progress-pct" id="_rpPct">0%</span>
      </div>
      <div class="research-bar-track">
        <div class="research-bar-fill" id="_rpBar" style="width:0%"></div>
      </div>
      <div class="research-steps" id="_rpSteps">
        <div class="research-steps-line"><div class="research-steps-line-fill" id="_rpLine" style="width:0%"></div></div>
        ${stepsInitHtml}
      </div>
      <div class="research-activity">
        <span class="research-activity-dot"></span>
        <span id="_rpMsg">Preparing research pipeline...</span>
      </div>
      <div class="research-log" id="_rpLog"><div class="rline">⏳ Starting research pipeline...</div></div>
    </div>`;
  area.scrollTop=area.scrollHeight;
  let _logLines=1;

  // Update existing DOM nodes in-place — no layout thrash
  const renderProgressBar=()=>{
    const titleEl=document.getElementById('_rpTitle');
    const pctEl=document.getElementById('_rpPct');
    const barEl=document.getElementById('_rpBar');
    const lineEl=document.getElementById('_rpLine');
    const msgEl=document.getElementById('_rpMsg');
    const stepsEl=document.getElementById('_rpSteps');
    const logEl=document.getElementById('_rpLog');
    if(!titleEl)return;
    titleEl.textContent=currentStep<stepNames.length?stepNames[currentStep]+'...':'Complete...';
    pctEl.textContent=Math.round(currentPct)+'%';
    barEl.style.width=currentPct+'%';
    const lineProgress=currentStep>0?Math.min(((currentStep)/(stepNames.length-1))*100,100):0;
    lineEl.style.width=lineProgress+'%';
    msgEl.textContent=lastMessage;
    // Append to activity log
    if(logEl&&lastMessage){
      const line=document.createElement('div');
      line.className='rline';
      line.textContent=`[${Math.round(currentPct)}%] ${lastMessage}`;
      logEl.appendChild(line);
      logEl.scrollTop=logEl.scrollHeight;
      _logLines++;
    }
    // Update step dots
    if(stepsEl){
      const dots=stepsEl.querySelectorAll('.research-step');
      dots.forEach((dot,i)=>{
        dot.className='research-step'+(i<currentStep?' done':(i===currentStep?' active':''));
        const dotInner=dot.querySelector('.research-step-dot');
        if(dotInner)dotInner.textContent=i<currentStep?'✓':(i===currentStep?stepIcons[i]:String(i+1));
      });
    }
  };

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
  let lastEventTime=Date.now();
  const STALL_TIMEOUT=300000; // 5 minutes — research AI calls can be very long

  while(true){
    // Race between reading and a stall timeout
    let stallTimer;
    const timeoutPromise=new Promise((_,reject)=>{
      stallTimer=setTimeout(()=>reject(new Error('Research appears stalled — no response from server for 5 minutes. Try again with a simpler query.')),STALL_TIMEOUT);
    });
    let readResult;
    try{
      readResult=await Promise.race([reader.read(),timeoutPromise]);
    }catch(e){
      clearTimeout(stallTimer);
      try{reader.cancel()}catch(_){}
      throw e;
    }
    clearTimeout(stallTimer);
    const{done,value}=readResult;
    if(done)break;
    lastEventTime=Date.now();
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
      }else if(evt.type==='heartbeat'){
        // Keep-alive, ignore
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
        const isPartial=!!evt.partial;
        finalReport=report;
        finalSources=srcs;
        const srcHtml=srcs.slice(0,15).map((s,i)=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title||('Source '+(i+1)))}</a></li>`).join('');
        const dl=[];
        if(evt.pdf_file)dl.push(`<a class="choice-btn" href="/api/research/download/${encodeURIComponent(evt.pdf_file)}">Download PDF</a>`);
        if(evt.md_file)dl.push(`<a class="choice-btn" href="/api/research/download/${encodeURIComponent(evt.md_file)}">Download Markdown</a>`);
        // Post-processing buttons (separate pipelines)
        const ppBtns=[];
        if(!evt.pdf_file)ppBtns.push(`<button class="choice-btn" onclick="postprocessPDF(this)" data-query="${esc(query).replace(/"/g,'&quot;')}">📄 Generate PDF</button>`);
        ppBtns.push(`<button class="choice-btn" onclick="postprocessMindmap(this)" data-query="${esc(query).replace(/"/g,'&quot;')}">🧠 Build Mind Map</button>`);
        const partialNote=isPartial?`<div class="research-partial-note" style="background:var(--surface-2);border-left:3px solid var(--amber);padding:8px 12px;margin:8px 0;border-radius:6px;font-size:0.9em;color:var(--text-secondary)">⚠️ This report was generated from partial data. ${evt.error_note||'Some pipeline phases may have been skipped.'}</div>`:'';
        contentEl.innerHTML=`
          <div class="research-badge">${isPartial?'⚠️ Research (partial)':'✅ Research complete'} · ${esc(depth)} · ${Number(evt.source_count||srcs.length)} sources</div>
          ${partialNote}
          <div class="research-actions">${dl.join('')}</div>
          <div class="research-postprocess" style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">${ppBtns.join('')}</div>
          ${srcHtml?`<div class="research-summary"><strong>Top sources</strong><ol style="margin:8px 0 0 18px">${srcHtml}</ol></div>`:''}
          <div style="margin-top:10px">${fmt(report.slice(0,32000))}</div>
          <button class="research-regen-btn" onclick="regenerateResearch('${esc(query).replace(/'/g,"\\'")}')">🔄 Regenerate</button>
        `;
        setStatus(isPartial?'Research completed with partial data.':'Research complete. You can download the report.');
        researchCompleted=true;
        // Store for post-processing
        _lastResearchReport=finalReport;
        _lastResearchSources=finalSources;
      }else if(evt.type==='error'){
        throw new Error(evt.error||'Research failed.');
      }
    }
  }
  _currentResearchJobId=null;
  _currentResearchReader=null;
  // If stream ended but we never got a 'done' event, it stalled
  if(!researchCompleted&&!wasCancelled){
    throw new Error('Research pipeline ended unexpectedly. This may be a server-side timeout or search failure. Try again with a simpler query or "quick" depth.');
  }
}

function regenerateResearch(query){
  const input=document.getElementById('msgInput');
  input.value=query;
  if(!activeTools.has('research')) activateTool('research');
  sendMessage();
}

/* ─── Post-Processing (separate from research pipeline) ─────── */
let _lastResearchReport='';
let _lastResearchSources=[];

async function postprocessPDF(btn){
  if(!btn)return;
  // Find the report from the closest research result
  const contentEl=btn.closest('.msg-content')||btn.closest('.msg');
  const reportText=_lastResearchReport||contentEl?.innerText||'';
  if(!reportText||reportText.length<100){showToast('No research report found to export.','info');return;}

  const origText=btn.textContent;
  btn.disabled=true;
  btn.textContent='⏳ Generating PDF...';

  try{
    const r=await apiFetch('/api/research/export/pdf',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({report:_lastResearchReport,title:btn.dataset.query||'Research Report',sources:_lastResearchSources})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'PDF generation failed.','error');
      btn.textContent=origText;btn.disabled=false;
      return;
    }
    // Replace button with download link
    const link=document.createElement('a');
    link.className='choice-btn';
    link.href=`/api/research/download/${encodeURIComponent(d.pdf_file)}`;
    link.textContent='📄 Download PDF';
    btn.replaceWith(link);
    showToast('PDF generated successfully!','success');
  }catch(e){
    showToast('PDF generation failed: '+e.message,'error');
    btn.textContent=origText;btn.disabled=false;
  }
}

async function postprocessMindmap(btn){
  if(!btn)return;
  if(!_lastResearchReport||_lastResearchReport.length<100){showToast('No research report found.','info');return;}

  const origText=btn.textContent;
  btn.disabled=true;
  btn.textContent='⏳ Building mind map...';

  try{
    const r=await apiFetch('/api/research/export/mindmap',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({report:_lastResearchReport})});
    const d=await r.json();
    if(!r.ok||d.error){
      showToast(d.error||'Mind map generation failed.','error');
      btn.textContent=origText;btn.disabled=false;
      return;
    }
    // Render mind map inline
    const mmData=d.mindmap;
    const mmId='mm_'+Date.now();
    const mmHtml=_renderMindmapNode(mmData,0);
    const container=document.createElement('div');
    container.className='research-mindmap';
    container.id=mmId;
    container.innerHTML=`<div class="research-mindmap-title">🧠 Mind Map</div>${mmHtml}`;
    btn.replaceWith(container);
    showToast('Mind map generated!','success');
  }catch(e){
    showToast('Mind map failed: '+e.message,'error');
    btn.textContent=origText;btn.disabled=false;
  }
}

function _renderMindmapNode(node,level){
  if(!node||!node.title)return'';
  const indent=level*20;
  const isRoot=level===0;
  const cls=isRoot?'mm-root':'mm-node';
  const childHtml=(node.children||[]).map(c=>_renderMindmapNode(c,level+1)).join('');
  return`<div class="${cls}" style="margin-left:${indent}px">
    <div class="mm-label" style="font-weight:${level<2?'600':'400'};font-size:${Math.max(12,15-level)}px;padding:4px 8px;margin:2px 0;border-left:${level>0?'2px solid var(--accent)':'none'};${isRoot?'font-size:16px;font-weight:700;margin-bottom:6px':''}">
      ${esc(node.title)}
    </div>
    ${childHtml?'<div class="mm-children">'+childHtml+'</div>':''}
  </div>`;
}

/* ─── Inline Research Plan (in-chat + canvas) ─────── */
let _inlineResearchState=null; // {query, depth, cardEl, contentEl}

async function startInlineResearchPlan(query,depth){
  depth=depth||deepResearchDepth||'standard';
  const area=document.getElementById('chatArea');

  // Create inline plan card in chat
  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  const contentEl=document.createElement('div');
  contentEl.className='msg-content';
  msgDiv.innerHTML='<div class="lbl">gyro</div>';
  msgDiv.appendChild(contentEl);
  area.appendChild(msgDiv);
  area.scrollTop=area.scrollHeight;

  // Loading state
  contentEl.innerHTML=`
    <div class="ri-card">
      <div class="ri-header">
        <span class="research-plan-badge">Deep Research</span>
        <span class="ri-depth">${esc(depth)}</span>
      </div>
      <div class="ri-query">${esc(query)}</div>
      <div class="ri-loading">
        <div class="dots" style="display:inline-flex"><span></span><span></span><span></span></div>
        <span>Generating research plan...</span>
      </div>
    </div>`;

  _inlineResearchState={query,depth,cardEl:msgDiv,contentEl};

  try{
    const r=await apiFetch('/api/research/plan',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query,depth})});
    const d=await r.json();
    if(!r.ok||d.error) throw new Error(d.error||'Failed to generate plan.');

    const angles=d.angles||[];
    const planText=angles.map((a,i)=>`${i+1}. ${a}`).join('\n');
    _inlineResearchState.planText=planText;
    _inlineResearchState.angles=angles;

    // Show plan preview in chat with expandable card
    const previewHtml=angles.map((a,i)=>`<div class="ri-angle"><span class="ri-angle-num">${i+1}</span>${esc(a)}</div>`).join('');
    contentEl.innerHTML=`
      <div class="ri-card">
        <div class="ri-header">
          <span class="research-plan-badge">Research Plan</span>
          <span class="ri-depth">${esc(depth)}</span>
        </div>
        <div class="ri-query">${esc(query)}</div>
        <button class="ri-toggle" id="riTogglePlan" onclick="toggleResearchPlan()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          <span>${angles.length} research angles</span>
        </button>
        <div class="ri-angles" id="riAnglesWrap">${previewHtml}</div>
        <div class="ri-actions">
          <button class="ri-btn-cancel" onclick="cancelInlineResearch()" title="Cancel">✕</button>
          <button class="ri-btn-confirm" onclick="confirmInlineResearchPlan()" title="Confirm & Start">✓</button>
        </div>
      </div>`;
    area.scrollTop=area.scrollHeight;
  }catch(e){
    contentEl.innerHTML=`
      <div class="ri-card ri-card-error">
        <div class="ri-header"><span class="research-plan-badge">Deep Research</span></div>
        <div style="color:var(--red);margin-top:10px">${esc(e.message||'Failed to generate plan.')}</div>
        <div class="ri-actions">
          <button class="research-btn-back" onclick="cancelInlineResearch()">Dismiss</button>
        </div>
      </div>`;
    _inlineResearchState=null;
  }
}

function toggleResearchPlan(){
  const wrap=document.getElementById('riAnglesWrap');
  const btn=document.getElementById('riTogglePlan');
  if(!wrap||!btn)return;
  wrap.classList.toggle('expanded');
  btn.classList.toggle('expanded');
}

function editResearchPlanInCanvas(){
  if(!_inlineResearchState)return;
  openCanvas(_inlineResearchState.planText||'','Research Plan',false,{sourcePath:'__research_plan__',openPanel:true});
}

async function confirmInlineResearchPlan(){
  if(!_inlineResearchState)return;
  // Use stored plan text (user can edit via canvas if they opened it)
  const tab=canvasTabs.find(t=>t.sourcePath==='__research_plan__');
  let planText=tab?tab.content:(_inlineResearchState.planText||'');
  if(!planText.trim()){showToast('Plan cannot be empty.','info');return;}

  const {query,depth,contentEl}=_inlineResearchState;
  _inlineResearchState=null;

  // Close canvas plan tab
  if(tab){
    canvasTabs=canvasTabs.filter(t=>t.id!==tab.id);
    if(activeCanvasTabId===tab.id){
      if(canvasTabs.length)switchCanvasTab(canvasTabs[canvasTabs.length-1].id);
      else closeCanvas();
    }else{renderCanvasTabs();}
  }

  // Start research inline
  const targetChatId=curChat;
  setChatRunning(targetChatId,true,{type:'research'});
  const area=document.getElementById('chatArea');
  try{
    await runDeepResearch(query,contentEl,area,planText);
    await refreshChats();
  }catch(e){
    contentEl.innerHTML=`<div style="color:var(--red)">${esc(e.message||'Research failed.')}</div>`;
    setStatus('Research failed.');
  }finally{
    setChatRunning(targetChatId,false);
  }
}

function cancelInlineResearch(){
  if(_inlineResearchState&&_inlineResearchState.cardEl){
    _inlineResearchState.cardEl.remove();
  }
  // Close canvas plan tab if open
  const tab=canvasTabs.find(t=>t.sourcePath==='__research_plan__');
  if(tab){
    canvasTabs=canvasTabs.filter(t=>t.id!==tab.id);
    if(activeCanvasTabId===tab.id){
      if(canvasTabs.length)switchCanvasTab(canvasTabs[canvasTabs.length-1].id);
      else closeCanvas();
    }else{renderCanvasTabs();}
  }
  _inlineResearchState=null;
  setStatus('Research cancelled.');
}

// ─── Messaging ────────────────────────────────────
function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px'}
function sendQ(t){document.getElementById('msgInput').value=t;sendMessage()}

function renderImageGrid(query, images){
  if(!images||!images.length)return'';
  const cards=images.map(img=>{
    const safeUrl=esc(img.url||'');
    const safeThumb=esc(img.thumbnail||img.url||'');
    const safeTitle=esc(img.title||'');
    return `<div class="img-grid-card" onclick="openImageLightbox('${safeUrl}','${safeTitle}')">`
      +`<img src="${safeThumb}" alt="${safeTitle}" loading="lazy" onerror="this.parentElement.style.display='none'">`
      +`<div class="img-grid-label">${safeTitle}</div>`
      +`</div>`;
  }).join('');
  const countCls=images.length===1?'img-grid-single':'img-grid-pair';
  return `<div class="img-grid-wrap ${countCls}">`
    +`<div class="img-grid-header"><span class="img-car-icon">🖼</span> Images for "${esc(query)}"</div>`
    +`<div class="img-grid-items">${cards}</div>`
    +`</div>`;
}

function renderImageCarousel(query, images){
  if(!images||!images.length)return'';
  const cards=images.map(img=>{
    const safeUrl=esc(img.url||'');
    const safeThumb=esc(img.thumbnail||img.url||'');
    const safeTitle=esc(img.title||'');
    const safeCtx=esc(img.context_url||'');
    return `<div class="img-car-card" onclick="openImageLightbox('${safeUrl}','${safeTitle}')">`
      +`<img src="${safeThumb}" alt="${safeTitle}" loading="lazy" onerror="this.parentElement.style.display='none'">`
      +`<div class="img-car-label">${safeTitle}</div>`
      +`</div>`;
  }).join('');
  return `<div class="img-car-wrap">`
    +`<div class="img-car-header"><span class="img-car-icon">🖼</span> Images for "${esc(query)}"</div>`
    +`<div class="img-car-track">`
    +`<button class="img-car-arrow img-car-left" onclick="event.stopPropagation();this.nextElementSibling.scrollBy({left:-260,behavior:'smooth'})">&lsaquo;</button>`
    +`<div class="img-car-scroll">${cards}</div>`
    +`<button class="img-car-arrow img-car-right" onclick="event.stopPropagation();this.previousElementSibling.scrollBy({left:260,behavior:'smooth'})">&rsaquo;</button>`
    +`</div>`
    +`</div>`;
}

function renderImageBlock(ir){
  if(!ir||!ir.images||!ir.images.length)return'';
  if(ir.images.length<=3)return renderImageGrid(ir.query, ir.images);
  return renderImageCarousel(ir.query, ir.images);
}

function renderChoiceBlock(choices,question,multi){
  const letters='ABCDEFGH';
  const qHTML=question?`<div class="cq-question">${esc(question)}</div>`:'';
  const multiAttr=multi?'data-multi="true"':'';
  const optsHTML=choices.map((c,i)=>{
    const letter=letters[i]||String(i+1);
    const safeText=esc(c.trim()).replace(/'/g,"\\'");
    return `<button class="cq-opt" onclick="pickChoice(this,'${safeText}')">`
      +`<span class="cq-letter">${letter}</span>`
      +`<span class="cq-text">${esc(c.trim())}</span>`
      +`</button>`;
  }).join('');
  const multiHint=multi?'<div class="cq-multi-hint">Select multiple</div>':'';
  return `<div class="cq-block" ${multiAttr}>${qHTML}${multiHint}<div class="cq-opts">${optsHTML}</div>`
    +`<div class="cq-custom"><input class="cq-input" placeholder="Or type your own answer…" onkeydown="if(event.key==='Enter'){event.preventDefault();pickCustomChoice(this)}"/>`
    +`<button class="cq-send" onclick="pickCustomChoice(this.previousElementSibling)" title="Send">→</button></div></div>`;
}

function pickChoice(btn,text){
  const block=btn.closest('.cq-block');
  const isMulti=block.dataset.multi==='true';
  if(isMulti){
    btn.classList.toggle('cq-selected');
    const selected=[...block.querySelectorAll('.cq-opt.cq-selected')].map(b=>b.querySelector('.cq-text').textContent.trim());
    block.dataset.answer=selected.join(', ');
  } else {
    block.querySelectorAll('.cq-opt').forEach(b=>b.classList.remove('cq-selected'));
    btn.classList.add('cq-selected');
    block.dataset.answer=text;
  }
  _afterChoicePick(block);
}

function pickCustomChoice(input){
  const text=(input.value||'').trim();
  if(!text)return;
  const block=input.closest('.cq-block');
  block.querySelectorAll('.cq-opt').forEach(b=>b.classList.remove('cq-selected'));
  block.dataset.answer=text;
  _afterChoicePick(block);
}

function _afterChoicePick(block){
  const group=block.closest('.cq-group');
  const blocks=group?group.querySelectorAll('.cq-block'):[block];
  const isMulti=block.dataset.multi==='true';
  const hasSubmitBtn=group&&group.querySelector('.cq-submit-all');
  if(blocks.length<=1&&!isMulti){
    // Single question, single-select — send immediately (old behavior)
    block.querySelectorAll('.cq-opt').forEach(b=>{b.disabled=true;b.style.pointerEvents='none';});
    const cr=block.querySelector('.cq-custom');if(cr)cr.style.display='none';
    sendQ(block.dataset.answer);
    return;
  }
  // Multiple questions or multi-select — enable submit button when all answered
  const allAnswered=[...blocks].every(b=>b.dataset.answer);
  const submitBtn=group.querySelector('.cq-submit-all');
  if(submitBtn)submitBtn.disabled=!allAnswered;
}

function submitAllChoices(btn){
  const group=btn.closest('.cq-group');
  const blocks=group.querySelectorAll('.cq-block');
  const parts=[...blocks].map(b=>{
    const q=b.querySelector('.cq-question');
    const qText=q?q.textContent.trim():'';
    const a=b.dataset.answer||'';
    return qText?qText+' '+a:a;
  });
  blocks.forEach(b=>{
    b.querySelectorAll('.cq-opt').forEach(o=>{o.disabled=true;o.style.pointerEvents='none';});
    const cr=b.querySelector('.cq-custom');if(cr)cr.style.display='none';
  });
  btn.disabled=true;btn.textContent='Submitted ✓';
  sendQ(parts.join('\n'));
}

function _detectTruncation(text){
  if(!text||text.length<200)return false;
  const t=text.trim();
  // Unclosed code blocks (odd number of ```)
  const fenceCount=(t.match(/```/g)||[]).length;
  if(fenceCount%2!==0)return true;
  // Unclosed special tags
  const openTags=['<<<CODE_EXECUTE','<<<FILE_CREATE','<<<FILE_UPDATE','<<<CHOICES>>>'];
  const closeTags=['<<<END_CODE>>>','<<<END_FILE>>>','<<<END_FILE>>>','<<<END_CHOICES>>>'];
  for(let i=0;i<openTags.length;i++){
    const opens=(t.match(new RegExp(openTags[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
    const closes=(t.match(new RegExp(closeTags[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length;
    if(opens>closes)return true;
  }
  // Ends with obvious mid-sentence indicators
  const lastLine=t.split('\n').pop().trim();
  if(lastLine&&/[,;:\-–—]$/.test(lastLine))return true;
  // Ends mid-word or mid-sentence (no sentence-ending punctuation)
  if(lastLine&&lastLine.length>20&&!/[.!?)\]"'…]$/.test(lastLine))return true;
  // Numbered list that seems incomplete (ends with a number item, likely more coming)
  const lines=t.split('\n').filter(l=>l.trim());
  const lastThree=lines.slice(-3);
  const numberedCount=lastThree.filter(l=>/^\s*\d+[.)]\s/.test(l)).length;
  if(numberedCount>=2)return true;
  // Sentences like "Stand by." or "Here's" or "I'll now" that promise more content
  if(/(?:stand by|here (?:is|are|comes)|i(?:'ll| will| am going to) (?:now|next)|let me|coming up|let's (?:start|continue|move|look)|first,|next,)[.\s]*$/i.test(lastLine))return true;
  return false;
}

function stripMetaBlocks(text){
  return (text||'')
    .replace(/<<<THINKING>>>[\s\S]*?(<<<END_THINKING>>>|$)/g,'')
    .replace(/<<<THINKING[\s\S]*$/g,'')
    .replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?(<<<END_CHOICES>>>|$)/g,'')
    .replace(/<<<IMAGE_SEARCH:\s*.+?>>>/g,'')
    .replace(/<<<DEEP_RESEARCH[:\s][\s\S]*?>>>/g,'')
    .replace(/<<<DEEP_RESEARCH>>>/g,'')
    .trim();
}

function hasUnclosedCodeFence(text){
  return ((text||'').match(/```/g)||[]).length%2===1;
}

// Live markdown formatter for streaming — formats text in-flight
function fmtLive(raw){
  if(!raw)return'<span class="stream-cursor"></span>';
  // Strip meta blocks (thinking/choices tags during stream)
  let t=stripMetaBlocks(raw);
  // Strip <<<CONTINUE>>> tag from live display
  t=t.replace(/<<<CONTINUE>>>/g,'');
  if(!t)return'<span class="stream-cursor"></span>';
  let html=t;
  // Escape HTML entities
  html=html.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Detect special blocks mid-stream and show placeholders
  // Unclosed DEEP_RESEARCH tag mid-stream (after HTML escaping, <<< becomes &lt;&lt;&lt;)
  if(/&lt;&lt;&lt;DEEP_RESEARCH/i.test(html)){
    html=html.replace(/&lt;&lt;&lt;DEEP_RESEARCH[\s\S]*$/,'');
  }
  // Strip FILE_CREATE / FILE_UPDATE / MEMORY_ADD / IMAGE_SEARCH / CONTINUE tags from live display
  html=html.replace(/&lt;&lt;&lt;(?:FILE_CREATE|FILE_UPDATE):[\s\S]*?&lt;&lt;&lt;END_FILE&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;(?:FILE_CREATE|FILE_UPDATE):[\s\S]*$/,''); // unclosed
  html=html.replace(/&lt;&lt;&lt;MEMORY_ADD:[^&]*?&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;IMAGE_SEARCH:[^&]*?&gt;&gt;&gt;/g,'');
  html=html.replace(/&lt;&lt;&lt;CONTINUE&gt;&gt;&gt;/g,'');
  // Unclosed mermaid block
  if(/```mermaid\n/i.test(html)&&!(/```mermaid\n[\s\S]*?```/.test(html))){
    html=html.replace(/```mermaid\n[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">●</span> Generating mind map...</div>');
  }
  // Unclosed todolist block
  if(/```todolist\n/i.test(html)&&!(/```todolist\n[\s\S]*?```/.test(html))){
    html=html.replace(/```todolist\n[\s\S]*$/,'<div class="stream-placeholder"><span class="sp-icon">●</span> Generating task list...</div>');
  }
  // Unclosed generic code block — show artifact generating
  if(hasUnclosedCodeFence(html)){
    // Get the language hint if present
    const fenceMatch=html.match(/```(\w+)\n(?![\s\S]*```)/);
    const lang=fenceMatch?fenceMatch[1]:'code';
    const langLabel={'python':'Python','javascript':'JavaScript','js':'JavaScript','html':'HTML','css':'CSS','json':'JSON','markdown':'Markdown','md':'Markdown','sql':'SQL','bash':'Shell','sh':'Shell','typescript':'TypeScript','ts':'TypeScript'}[lang.toLowerCase()]||lang;
    html=html.replace(/```\w*\n[^]*$/,'<div class="stream-placeholder"><span class="sp-icon">●</span> Writing '+esc(langLabel)+' artifact...</div>');
  }

  // Completed mermaid blocks — show placeholder until fmt() renders the real diagram
  html=html.replace(/```mermaid\n[\s\S]*?```/g,'<div class="stream-placeholder"><span class="sp-icon">🗺️</span> Mind map ready — rendering...</div>');
  // Completed todolist blocks — show placeholder until fmt() renders the interactive list
  html=html.replace(/```todolist\n[\s\S]*?```/g,'<div class="stream-placeholder"><span class="sp-icon">✅</span> Task list ready — rendering...</div>');
  // Completed code blocks: render styled
  html=html.replace(/```(\w*)\n([\s\S]*?)```/g,(_,l,c)=>{
    return '<pre class="stream-code"><code>'+c+'</code></pre>';
  });

  // Bold
  html=html.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  // Inline code
  html=html.replace(/`(.+?)`/g,'<code class="stream-inline-code">$1</code>');
  // Links
  html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Bare URLs — auto-link any https?:// not already inside an <a> tag
  html=html.replace(/(?<!href=")(?<!src=")(?<!">)(https?:\/\/[^\s<"']+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
  // Headings (### at start of line)
  html=html.replace(/^(#{1,3})\s+(.+)$/gm,(_,h,text)=>{
    const level=h.length;
    const sizes=['1.3em','1.15em','1.05em'];
    return `<div style="font-size:${sizes[level-1]||'1em'};font-weight:700;margin:12px 0 4px;color:var(--text-primary)">${text}</div>`;
  });
  // Bullet lists  — * or - at start of line
  html=html.replace(/^([*\-])\s+(.+)$/gm,'<div style="display:flex;gap:8px;padding:1px 0"><span style="color:var(--accent);flex-shrink:0">•</span><span>$2</span></div>');
  // Numbered lists — 1. at start of line
  html=html.replace(/^(\d+)\.\s+(.+)$/gm,'<div style="display:flex;gap:8px;padding:1px 0"><span style="color:var(--accent);flex-shrink:0;min-width:16px;text-align:right">$1.</span><span>$2</span></div>');
  // Newlines
  html=html.replace(/\n/g,'<br>');
  // Add cursor at end
  html+='<span class="stream-cursor"></span>';
  return html;
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
  const codeBlocks=[];
  while((m=codeRe.exec(reply||''))!==null){
    const lang=(m[1]||'text').toLowerCase();
    if(lang==='todolist'||lang==='mermaid')continue;
    const content=m[2]||'';
    const isCode=lang!=='text'&&lang!=='md'&&lang!=='markdown';
    // Try to detect a filename from the line before the code block
    const before=reply.substring(0,m.index).trim();
    const lastLine=before.split('\n').pop().trim();
    let title='';
    const fnMatch=lastLine.match(/`?(\w[\w.-]*\.\w+)`?/);
    if(fnMatch)title=fnMatch[1];
    if(!title){
      const extMap={python:'script.py',py:'script.py',javascript:'script.js',js:'script.js',html:'page.html',css:'styles.css',java:'Main.java',cpp:'main.cpp',c:'main.c',typescript:'script.ts',ts:'script.ts',rust:'main.rs',go:'main.go',ruby:'script.rb',php:'script.php',swift:'main.swift',kotlin:'Main.kt',sql:'query.sql',bash:'script.sh',sh:'script.sh',json:'data.json',yaml:'config.yaml',yml:'config.yml',xml:'data.xml',toml:'config.toml'};
      title=extMap[lang]||`snippet_${idx}.${lang||'txt'}`;
    }
    idx++;
    ids.push(registerArtifact({title,content,isCode,path:''}));
    if(isCode)codeBlocks.push({title,content,lang});
  }
  for(const f of(filesModified||[])){
    if(!f?.path)continue;
    ids.push(registerArtifact({title:f.path.split('/').pop()||f.path,path:f.path,content:'',isCode:true,action:f.action||'updated'}));
  }
  // Auto-open first code block in canvas
  if(codeBlocks.length>0&&!_suppressCanvasAutoOpen){
    const first=codeBlocks[0];
    setTimeout(()=>openCanvas(first.content,first.title,true,{openPanel:true}),100);
  }
  return [...new Set(ids)];
}

function renderArtifactCards(ids,state='ready'){
  // No longer rendering artifact cards — canvas auto-opens instead
  return '';
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

async function sendMessage(opts){
  const _silent=opts&&opts.silent;
  const _noThinking=opts&&opts.noThinking;
  const input=document.getElementById('msgInput');const text=input.value.trim();
  if(!text&&!pendingFiles.length)return;
  // Reset continue counter when user sends a new (non-continue) message
  if(!text.startsWith('Continue'))_continueCount=0;
  if(curChat&&isChatRunning(curChat)){if(!_silent)showToast('Already generating in this chat — switch to another chat or wait.','info');return;}
  // Force-create a new chat if none exists (don't rely on createChat guard)
  if(!curChat){
    try{
      const cr=await apiFetch('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:_activeFolderView||pendingFolder||''})});
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

  if(!_silent)addMsg('user',text,[],{fileNames:files.map(f=>f.name),files});
  setStatus('Working on it...');
  input.value='';input.style.height='auto';
  pendingFiles=[];renderPF();
  if(!_silent)for(const f of files)uploadedHistory.unshift({name:f.name,mime:f.mime,when:Date.now()});

  // ── Research when explicitly activated via tool ──
  // Deep research silently enhances the prompt — no visible plan/modal
  // It's sent as part of activeTools in the normal chat flow

  const controller=new AbortController();
  setChatRunning(targetChatId,true,{type:'chat',controller});
  const area=document.getElementById('chatArea');

  const msgDiv=document.createElement('div');
  msgDiv.className='msg kairo';
  msgDiv.innerHTML='<div class="lbl">gyro</div><div class="msg-content"><div class="think-active" style="animation:thinkingIn .5s var(--ease-spring-snappy) both"><div class="dots"><span></span><span></span><span></span></div><span id="_thinkPhrase" style="display:inline-block;transition:opacity .3s ease,transform .3s ease"> Thinking...</span></div></div>';
  area.appendChild(msgDiv);area.scrollTop=area.scrollHeight;
  startThinkingPhrases(msgDiv.querySelector('#_thinkPhrase'));
  const contentEl=msgDiv.querySelector('.msg-content');
  const canRender=()=>curChat===targetChatId&&msgDiv.isConnected;

  try{
    // Collect active tool names and clear them for next message
    const toolsForMsg=[...activeTools];
    activeTools.clear();
    renderToolBadges();

    // If canvas is open, include canvas context for select-to-edit
    let messageToSend=text;
    const cCtx=getCanvasContext();
    if(cCtx){
      let canvasPrefix='';
      if(cCtx.selectedText){
        canvasPrefix=`[CANVAS CONTEXT — "${cCtx.title}"]\nThe user has selected this portion of the canvas:\n<<<SELECTED>>>\n${cCtx.selectedText}\n<<<END_SELECTED>>>\n\nFull canvas content:\n${cCtx.fullContent}\n\n[USER REQUEST]\n`;
        canvasSelection=null; // clear after use
      }else{
        canvasPrefix=`[CANVAS CONTEXT — "${cCtx.title}"]\nThe canvas currently contains:\n${cCtx.fullContent}\n\n[USER REQUEST]\n`;
      }
      messageToSend=canvasPrefix+text;
    }

    const response=await apiFetch(`/api/chats/${targetChatId}/stream`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:messageToSend,files,thinking:_noThinking?false:thinkingEnabled,active_tools:toolsForMsg}),signal:controller.signal});

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
          await createChat(_activeFolderView||pendingFolder||'');
          document.getElementById('msgInput').value=text;
          pendingFiles=files;
          renderPF();
          await sendMessage(opts);
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
    let buffer='',fullText='',thinkText='',isThinking=false;

    // Create a live thinking panel (collapsed by default — click to expand)
    let thinkPanel=null;
    let thinkTextEl=null;
    let _thinkSubjectSet=false;
    function _extractThinkSubject(text){
      const first=(text||'').split('\n').find(l=>l.trim())||'';
      const clean=first.replace(/^[-•*#>\s]+/,'').trim();
      if(clean.length>50)return clean.slice(0,50)+'…';
      return clean||'your question';
    }
    function ensureThinkPanel(){
      if(thinkPanel)return;
      const ta=contentEl.querySelector('.think-active');
      if(ta)ta.remove();
      stopThinkingPhrases();
      thinkPanel=document.createElement('div');
      thinkPanel.className='live-think-panel ltp-collapsed';
      thinkPanel.innerHTML='<div class="ltp-header" style="cursor:pointer"><span class="ltp-icon">💭</span><span class="ltp-label">Considering your question</span><span class="ltp-chevron">▾</span><span class="ltp-dots"><span></span><span></span><span></span></span></div><div class="ltp-body" style="max-height:0;padding:0;overflow:hidden;transition:max-height .3s var(--ease-smooth),padding .3s var(--ease-smooth)"><div class="ltp-text"></div></div>';
      const hdr=thinkPanel.querySelector('.ltp-header');
      const body=thinkPanel.querySelector('.ltp-body');
      hdr.onclick=()=>{
        const collapsed=thinkPanel.classList.contains('ltp-collapsed');
        thinkPanel.classList.toggle('ltp-collapsed',!collapsed);
        body.style.maxHeight=collapsed?'200px':'0';
        body.style.padding=collapsed?'12px 14px':'0';
      };
      contentEl.innerHTML='';
      contentEl.appendChild(thinkPanel);
      thinkTextEl=thinkPanel.querySelector('.ltp-text');
    }

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
          if(data.type==='thinking_delta'){
            if(!isThinking)console.log('[gyro] thinking_delta received — thinking panel activating');
            isThinking=true;
            thinkText+=data.text;
            if(canRender()){
              ensureThinkPanel();
              thinkTextEl.textContent=thinkText;
              thinkTextEl.scrollTop=thinkTextEl.scrollHeight;
              // Update the subject label once we have enough text
              if(!_thinkSubjectSet&&thinkText.length>15){
                const subj=_extractThinkSubject(thinkText);
                const lbl=thinkPanel.querySelector('.ltp-label');
                if(lbl)lbl.textContent='Considering '+subj;
                _thinkSubjectSet=true;
              }
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='delta'){
            // Transition from thinking to response
            if(isThinking&&thinkPanel){
              isThinking=false;
              thinkPanel.classList.add('ltp-done');
              const dotsEl=thinkPanel.querySelector('.ltp-dots');
              if(dotsEl)dotsEl.remove();
              // Add response area below
              const responseDiv=document.createElement('div');
              responseDiv.className='stream-response-area';
              contentEl.appendChild(responseDiv);
            }
            stopThinkingPhrases();
            fullText+=data.text;
            if(canRender()){
              const targetEl=contentEl.querySelector('.stream-response-area')||contentEl;
              // First delta: remove thinking indicator if still present
              const ta=contentEl.querySelector('.think-active');
              if(ta){ta.remove();stopThinkingPhrases();}
              targetEl.innerHTML=fmtLive(fullText);
              area.scrollTop=area.scrollHeight;
            }
          }else if(data.type==='done'){
            // Collapse live thinking panel if present
            if(thinkPanel){
              thinkPanel.classList.add('ltp-done');
              if(!thinkPanel.classList.contains('ltp-collapsed'))thinkPanel.classList.add('ltp-collapsed');
              const dotsEl=thinkPanel.querySelector('.ltp-dots');
              if(dotsEl)dotsEl.remove();
              const body=thinkPanel.querySelector('.ltp-body');
              if(body){body.style.maxHeight='0';body.style.padding='0';}
            }
            // Remove ALL thinking/loading indicators
            contentEl.querySelectorAll('.think-active,.live-think-panel:not(.ltp-done),.thinking').forEach(el=>{
              el.classList.add('ltp-done');
              el.style.animation='none';
            });
            stopThinkingPhrases();
            await new Promise(r=>setTimeout(r,150));
            let finalHTML='';
            let displayReply=data.reply||'';
            // If we already showed thinking live, use it for the think block
            if(thinkText){
              finalHTML+=renderThinkBlock(thinkText);
            } else if(displayReply.includes('<<<THINKING>>>')&&displayReply.includes('<<<END_THINKING>>>')){
              const parts=displayReply.split('<<<END_THINKING>>>');
              const thinkPart=parts[0].replace('<<<THINKING>>>','').trim();
              displayReply=parts.slice(1).join('<<<END_THINKING>>>').trim();
              finalHTML+=renderThinkBlock(thinkPart);
            }
            // Strip thinking tags from reply if still present
            displayReply=displayReply.replace(/<<<THINKING>>>[\s\S]*?<<<END_THINKING>>>/g,'').replace(/<<<\/?THINKING\/?>>>/g,'').trim();
            // Parse all choice blocks (supports multiple sequential questions)
            const choiceBlockRe=/(?:<<<QUESTION:(.*?)>>>\n)?<<<CHOICES(?:\|multi)?>>>\n([\s\S]*?)<<<END_CHOICES>>>/g;
            let choiceBlockMatch;
            const choiceBlocks=[];
            while((choiceBlockMatch=choiceBlockRe.exec(displayReply))!==null){
              const isMulti=/<<<CHOICES\|multi>>>/.test(choiceBlockMatch[0]);
              choiceBlocks.push({question:(choiceBlockMatch[1]||'').trim(),choices:choiceBlockMatch[2].trim().split('\n').filter(c=>c.trim()),multi:isMulti});
            }
            displayReply=displayReply.replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?<<<END_CHOICES>>>/g,'').trim();
            // Detect <<<CONTINUE>>> tag — AI wants to chain another message
            let shouldContinue=false;
            if(displayReply.includes('<<<CONTINUE>>>')){
              shouldContinue=true;
              displayReply=displayReply.replace(/<<<CONTINUE>>>/g,'').trim();
            }
            finalHTML+=fmt(displayReply);
            if(choiceBlocks.length){
              finalHTML+='<div class="cq-group">';
              for(const cb of choiceBlocks){
                if(cb.choices.length)finalHTML+=renderChoiceBlock(cb.choices,cb.question,cb.multi);
              }
              if(choiceBlocks.length>1||choiceBlocks.some(cb=>cb.multi))finalHTML+='<button class="cq-submit-all" onclick="submitAllChoices(this)" disabled>Submit Answers</button>';
              finalHTML+='</div>';
            }
            const artifactIds=registerArtifactsFromReply(displayReply,data.files||[]);
            if(data.files?.length){
              finalHTML+='<div class="fops">';
              for(const f of data.files){const fname=f.path.split('/').pop().split('\\').pop();finalHTML+=`<div class="fo"><a href="/api/files/download?path=${encodeURIComponent(f.path)}" target="_blank" class="fo-link">⬇ ${esc(f.action==='created'?'Created':'Updated')}: ${esc(fname)}</a></div>`;}
              finalHTML+='</div>';
            }
            finalHTML+=renderArtifactCards(artifactIds,'ready');
            if(data.code_results?.length){
              for(const cr of data.code_results){
                const statusCls=cr.success?'code-run-success':'code-run-error';
                finalHTML+=`<div class="code-run-block ${statusCls}"><div class="crb-header"><span class="crb-lang">${esc(cr.language)}</span><span class="crb-status">${cr.success?'✓ Executed':'✗ Error'}</span></div><pre class="crb-code"><code>${esc(cr.code)}</code></pre><div class="crb-output-label">Output</div><pre class="crb-output">${esc(cr.output)}</pre></div>`;
              }
            }
            if(data.memory_added?.length)finalHTML+=`<div class="mops">Remembered: ${data.memory_added.map(esc).join('; ')}</div>`;

            // ── Image search results — replace inline placeholders ──
            if(data.image_results?.length){
              // Build a map of index -> rendered HTML
              const imgMap={};
              for(const ir of data.image_results){
                imgMap[ir.index]=renderImageBlock(ir);
              }
              // Replace %%%IMGBLOCK:N%%% placeholders in the HTML (may be wrapped in <p> tags by markdown)
              finalHTML=finalHTML.replace(/<p>\s*%%%IMGBLOCK:(\d+)%%%\s*<\/p>|%%%IMGBLOCK:(\d+)%%%/g,(match,idx1,idx2)=>{
                const idx=parseInt(idx1||idx2,10);
                const html=imgMap[idx];
                return html||'';
              });
            }
            if(data.failed_images?.length){
              for(const fq of data.failed_images){
                finalHTML+=`<div class="img-search-fail"><span class="img-search-fail-icon">🖼</span> Image search for "${esc(fq)}" couldn't load — try again or search manually.</div>`;
              }
            }

            // ── AI-triggered deep research ──
            if(data.research_trigger&&!choiceBlocks.length){
              const rq=data.research_trigger;
              if(canRender()){
                contentEl.innerHTML=finalHTML;
                if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              }
              setChatRunning(targetChatId,false);
              setChatRunning(targetChatId,true,{type:'research'});
              try{
                await runDeepResearch(rq,contentEl,document.getElementById('chatArea'));
                await refreshChats();
                // After research completes, silently auto-continue so the AI can add commentary
                setChatRunning(targetChatId,false);
                try{
                  const inp=document.getElementById('msgInput');
                  inp.value='The deep research report above is now complete. Provide a brief executive summary highlighting the 3-5 most important findings, key takeaways, and any actionable recommendations. Be concise.';
                  sendMessage({silent:true,noThinking:true});
                }catch(_){}
              }catch(e){
                contentEl.innerHTML+=`<div style="color:var(--red);margin-top:12px">${esc(e.message||'Research failed.')}</div>`;
                setStatus('Research failed.');
                setChatRunning(targetChatId,false);
              }
              return;
            }

            if(canRender()){
              contentEl.style.opacity='1';contentEl.style.filter='';contentEl.style.transform='';
              contentEl.innerHTML=finalHTML;
              // Animate content in smoothly
              contentEl.style.opacity='0';
              contentEl.style.filter='blur(4px)';
              contentEl.style.transform='translateY(6px)';
              requestAnimationFrame(()=>{
                contentEl.style.transition='opacity .4s var(--ease-smooth), filter .4s var(--ease-smooth), transform .4s var(--ease-smooth)';
                contentEl.style.opacity='1';
                contentEl.style.filter='blur(0)';
                contentEl.style.transform='translateY(0)';
                setTimeout(()=>{
                  contentEl.style.transition='';
                  contentEl.style.filter='';
                  contentEl.style.transform='';
                },450);
              });
              if(data.title&&data.title!=='New Chat')document.getElementById('topTitle').textContent=data.title;
              try{Promise.resolve(mermaid.run()).then(()=>enhanceMermaidDiagrams())}catch{}
            }
            refreshChats();
            // Auto-continue if AI signaled <<<CONTINUE>>> or if the response was truncated
            if(!shouldContinue&&!choiceBlocks.length){
              shouldContinue=_detectTruncation(displayReply);
            }
            if(shouldContinue&&_continueCount<_MAX_CONTINUES){
              _continueCount++;
              setStatus(`Continuing... (${_continueCount})`);
              setTimeout(()=>{
                const inp=document.getElementById('msgInput');
                inp.value='Continue where you left off. Pick up exactly where you stopped.';
                sendMessage({silent:true,noThinking:true});
              },600);
            }else{
              _continueCount=0;
              setStatus('Done. Ask a follow-up or start something new.');
            }
            // If user navigated away and back, reload the chat so they see the response
            if(curChat===targetChatId&&!msgDiv.isConnected){
              openChat(targetChatId);
            }
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
  const summary=lines[0]?lines[0].replace(/^[-•*#>\s]+/,'').slice(0,50):'your question';
  return `<div class="think-block" onclick="this.classList.toggle('expanded')">
    <div class="think-header"><span>💭</span> <span>Considered ${esc(summary)}</span> <span class="think-chevron">▾</span></div>
    <div class="think-content">${esc(thinkText)}</div>
  </div>`;
}

function addMsg(role,text,files,extra={}){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className=`msg ${role}`;let html='';
  if(role==='kairo')html+='<div class="lbl">gyro</div>';
  if(role==='user'&&extra.files?.length){
    const previews=extra.files.map(f=>{
      const name=esc(f.name||'upload');
      if(f.mime?.startsWith('image/')&&f.data){
        return `<div class="user-file-preview image"><img src="data:${f.mime};base64,${f.data}" alt="${name}" loading="lazy"></div>`;
      }
      return `<div class="user-file-preview"><span>${name}</span></div>`;
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
  // Parse all choice blocks (supports multiple sequential questions)
  const choiceBlockRe2=/(?:<<<QUESTION:(.*?)>>>\n)?<<<CHOICES(?:\|multi)?>>>\n([\s\S]*?)<<<END_CHOICES>>>/g;
  let cbm2;
  const cBlocks=[];
  while((cbm2=choiceBlockRe2.exec(displayText))!==null){
    const isMulti=/<<<CHOICES\|multi>>>/.test(cbm2[0]);
    cBlocks.push({question:(cbm2[1]||'').trim(),choices:cbm2[2].trim().split('\n').filter(c=>c.trim()),multi:isMulti});
  }
  displayText=displayText.replace(/(?:<<<QUESTION:.*?>>>\n)?<<<CHOICES(?:\|multi)?>>>[\s\S]*?<<<END_CHOICES>>>/g,'').trim();
  // Long user text → collapsible file block
  if(role==='user'&&displayText.length>600){
    const lines=displayText.split('\n');
    const preview=lines.slice(0,3).join('\n');
    html+=`<div class="user-paste-file"><div class="upf-header" onclick="this.parentElement.classList.toggle('upf-expanded')">`
      +`<span class="upf-icon">📄</span><span class="upf-label">Pasted text (${lines.length} lines)</span><span class="upf-chevron">▾</span></div>`
      +`<div class="upf-preview">${esc(preview)}${lines.length>3?'\n…':''}</div>`
      +`<div class="upf-full"><pre>${esc(displayText)}</pre></div></div>`;
  } else {
    html+=fmt(displayText);
  }
  if(cBlocks.length&&role==='kairo'){
    html+='<div class="cq-group">';
    for(const cb of cBlocks){
      if(cb.choices.length)html+=renderChoiceBlock(cb.choices,cb.question,cb.multi);
    }
    if(cBlocks.length>1||cBlocks.some(cb=>cb.multi))html+='<button class="cq-submit-all" onclick="submitAllChoices(this)" disabled>Submit Answers</button>';
    html+='</div>';
  }
  let artifactIds=[];
  if(role==='kairo')artifactIds=registerArtifactsFromReply(displayText,files||[]);
  if(files?.length){html+='<div class="fops">';for(const f of files){const fname=f.path.split('/').pop().split('\\').pop();html+=`<div class="fo"><a href="/api/files/download?path=${encodeURIComponent(f.path)}" target="_blank" class="fo-link">⬇ ${esc(f.action==='created'?'Created':'Updated')}: ${esc(fname)}</a></div>`;}html+='</div>'}
  if(artifactIds.length)html+=renderArtifactCards(artifactIds,'ready');
  if(extra.code_results?.length){
    for(const cr of extra.code_results){
      const statusCls=cr.success?'code-run-success':'code-run-error';
      html+=`<div class="code-run-block ${statusCls}"><div class="crb-header"><span class="crb-lang">${esc(cr.language)}</span><span class="crb-status">${cr.success?'✓ Executed':'✗ Error'}</span></div><pre class="crb-code"><code>${esc(cr.code)}</code></pre><div class="crb-output-label">Output</div><pre class="crb-output">${esc(cr.output)}</pre></div>`;
    }
  }
  if(extra.memory_added?.length)html+=`<div class="mops">Remembered: ${extra.memory_added.map(esc).join('; ')}</div>`;
  if(role==='user'&&text)html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="editMsg(this)">✎ Edit</button></div>`;
  else if(role==='kairo')html+=`<div class="msg-actions"><button class="msg-action-btn" onclick="retryMsg(this)">↺ Retry</button></div>`;
  div.dataset.text=text||'';
  div.innerHTML=html;area.appendChild(div);area.scrollTop=area.scrollHeight;
}

function addThinking(){
  const area=document.getElementById('chatArea');const div=document.createElement('div');
  div.className='thinking';div.innerHTML='<div class="dots"><span></span><span></span><span></span></div> gyro is thinking...';
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
function countTodoItems(items){
  let total=0,done=0;
  for(const it of items){total++;if(it.done)done++;if(it.subtasks)for(const s of it.subtasks){total++;if(s.done)done++;}}
  return{total,done};
}

function renderTodoRowHTML(listId,item,isSub,parentId){
  const checked=item.done?'checked':'';
  const doneClass=item.done?'done':'';
  const subClass=isSub?'subtask':'';
  const pAttr=parentId?` data-parent-id="${parentId}"`:'';
  const pArg=parentId?`,'${parentId}'`:'';
  let h=`<div class="chat-todo-row ${doneClass} ${subClass}" data-item-id="${item.id}"${pAttr}>`;
  h+=`<button class="chat-todo-check ${checked}" onclick="toggleChatTodo('${listId}','${item.id}'${pArg})"><span>${item.done?'✓':''}</span></button>`;
  h+=`<span class="chat-todo-text" ondblclick="editChatTodo('${listId}','${item.id}',this${pArg})">${esc(item.text)}</span>`;
  if(!isSub)h+=`<button class="chat-todo-addsub" onclick="addSubtask('${listId}','${item.id}')" title="Add subtask">⊕</button>`;
  h+=`<button class="chat-todo-del" onclick="deleteChatTodo('${listId}','${item.id}'${pArg})" title="Delete">✕</button>`;
  h+=`</div>`;
  return h;
}

function renderChatTodoList(listId){
  const items=chatTodoStore.get(listId)||[];
  const{total,done}=countTodoItems(items);
  const pct=total?Math.round(done/total*100):0;
  let html=`<div class="chat-todo" data-list-id="${listId}">`;
  html+=`<div class="chat-todo-header"><span class="chat-todo-icon">☑</span><span class="chat-todo-title">${done}/${total} completed</span><div class="chat-todo-bar"><div class="chat-todo-bar-fill" style="width:${pct}%"></div></div></div>`;
  html+=`<div class="chat-todo-items">`;
  items.forEach(item=>{
    html+=renderTodoRowHTML(listId,item,false);
    if(item.subtasks&&item.subtasks.length){
      html+=`<div class="chat-todo-subtask-group" data-parent-id="${item.id}">`;
      item.subtasks.forEach(sub=>{html+=renderTodoRowHTML(listId,sub,true,item.id);});
      html+=`</div>`;
    }
  });
  html+=`</div>`;
  html+=`<div class="chat-todo-footer"><button class="chat-todo-add" onclick="addChatTodo('${listId}')">+ Add task</button></div>`;
  html+=`</div>`;
  return html;
}

function updateChatTodoHeader(listId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const items=chatTodoStore.get(listId)||[];
  const{total,done}=countTodoItems(items);
  const pct=total?Math.round(done/total*100):0;
  const title=el.querySelector('.chat-todo-title');
  if(title)title.textContent=`${done}/${total} completed`;
  const fill=el.querySelector('.chat-todo-bar-fill');
  if(fill)fill.style.width=pct+'%';
  syncChatTodosToStorage(listId);
}

function findTodoItem(items,itemId,parentId){
  if(parentId){const p=items.find(i=>i.id===parentId);return p&&p.subtasks?p.subtasks.find(s=>s.id===itemId):null;}
  return items.find(i=>i.id===itemId);
}

function updateRowDOM(listId,itemId,done){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const row=el.querySelector(`.chat-todo-row[data-item-id="${itemId}"]`);
  if(!row)return;
  row.classList.toggle('done',done);
  const check=row.querySelector('.chat-todo-check');
  if(check){check.classList.toggle('checked',done);check.querySelector('span').textContent=done?'✓':'';}
}

function autoCheckParent(listId,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const parent=items.find(i=>i.id===parentId);
  if(!parent||!parent.subtasks||!parent.subtasks.length)return;
  const allDone=parent.subtasks.every(s=>s.done);
  if(allDone&&!parent.done){parent.done=true;updateRowDOM(listId,parentId,true);}
  else if(!allDone&&parent.done){parent.done=false;updateRowDOM(listId,parentId,false);}
}

function syncChatTodosToStorage(listId){
  const items=chatTodoStore.get(listId)||[];
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>!t.id.startsWith(listId));
  items.forEach(it=>{
    state.todos.push({id:it.id,text:it.text,done:it.done});
    if(it.subtasks)it.subtasks.forEach(s=>{state.todos.push({id:s.id,text:s.text,done:s.done});});
  });
  saveProductivityState(state);
}

function toggleChatTodo(listId,itemId,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const item=findTodoItem(items,itemId,parentId);
  if(!item)return;
  item.done=!item.done;
  updateRowDOM(listId,itemId,item.done);
  if(parentId)autoCheckParent(listId,parentId);
  updateChatTodoHeader(listId);
}

function deleteChatTodo(listId,itemId,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  const row=el?.querySelector(`.chat-todo-row[data-item-id="${itemId}"]`);
  if(row){
    row.classList.add('removing');
    row.addEventListener('animationend',()=>{
      row.remove();
      if(!parentId){const sg=el.querySelector(`.chat-todo-subtask-group[data-parent-id="${itemId}"]`);if(sg)sg.remove();}
    },{once:true});
  }
  if(parentId){
    const parent=items.find(i=>i.id===parentId);
    if(parent&&parent.subtasks){
      parent.subtasks=parent.subtasks.filter(s=>s.id!==itemId);
      setTimeout(()=>{const sg=el?.querySelector(`.chat-todo-subtask-group[data-parent-id="${parentId}"]`);if(sg&&!sg.children.length)sg.remove();},250);
      autoCheckParent(listId,parentId);
    }
  }else{
    chatTodoStore.set(listId,items.filter(i=>i.id!==itemId));
  }
  updateChatTodoHeader(listId);
}

function editChatTodo(listId,itemId,el,parentId){
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const item=findTodoItem(items,itemId,parentId);
  if(!item)return;
  const input=document.createElement('input');
  input.type='text';input.value=item.text;
  input.className='chat-todo-edit-input';
  let committed=false;
  const commit=()=>{
    if(committed)return;committed=true;
    const val=input.value.trim();
    if(val){item.text=val;el.textContent=val;}
    else el.textContent=item.text;
    syncChatTodosToStorage(listId);
  };
  input.onblur=commit;
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.blur();}if(e.key==='Escape'){input.value=item.text;input.blur();}};
  el.textContent='';
  el.appendChild(input);
  input.focus();input.select();
}

function addChatTodo(listId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const container=el.querySelector('.chat-todo-items');
  if(!container)return;
  const row=document.createElement('div');
  row.className='chat-todo-row adding';
  row.innerHTML=`<button class="chat-todo-check"><span></span></button><input class="chat-todo-edit-input" type="text" placeholder="Type task name…"><button class="chat-todo-del" style="opacity:1" title="Cancel">✕</button>`;
  container.appendChild(row);
  const input=row.querySelector('input');
  let committed=false;
  const commit=()=>{
    if(committed)return;committed=true;
    const val=input.value.trim();
    if(val){
      const items=chatTodoStore.get(listId)||[];
      const newId=listId+'_'+Date.now().toString(36);
      const newItem={id:newId,text:val,done:false,subtasks:[]};
      items.push(newItem);
      row.outerHTML=renderTodoRowHTML(listId,newItem,false);
      updateChatTodoHeader(listId);
    }else{
      row.classList.add('removing');
      setTimeout(()=>row.remove(),200);
    }
  };
  input.addEventListener('blur',commit);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();input.blur();}
    if(e.key==='Escape'){input.value='';input.blur();}
  });
  row.querySelector('.chat-todo-del').addEventListener('click',()=>{input.value='';input.blur();});
  requestAnimationFrame(()=>input.focus());
}

function addSubtask(listId,parentId){
  const el=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
  if(!el)return;
  const items=chatTodoStore.get(listId);
  if(!items)return;
  const parent=items.find(i=>i.id===parentId);
  if(!parent)return;
  if(!parent.subtasks)parent.subtasks=[];
  let subGroup=el.querySelector(`.chat-todo-subtask-group[data-parent-id="${parentId}"]`);
  if(!subGroup){
    subGroup=document.createElement('div');
    subGroup.className='chat-todo-subtask-group';
    subGroup.dataset.parentId=parentId;
    const parentRow=el.querySelector(`.chat-todo-row[data-item-id="${parentId}"]`);
    if(parentRow)parentRow.after(subGroup);
  }
  const row=document.createElement('div');
  row.className='chat-todo-row subtask adding';
  row.innerHTML=`<button class="chat-todo-check"><span></span></button><input class="chat-todo-edit-input" type="text" placeholder="Type subtask…"><button class="chat-todo-del" style="opacity:1" title="Cancel">✕</button>`;
  subGroup.appendChild(row);
  const input=row.querySelector('input');
  let committed=false;
  const commit=()=>{
    if(committed)return;committed=true;
    const val=input.value.trim();
    if(val){
      const newId=parentId+'_s'+Date.now().toString(36);
      const newSub={id:newId,text:val,done:false};
      parent.subtasks.push(newSub);
      row.outerHTML=renderTodoRowHTML(listId,newSub,true,parentId);
      updateChatTodoHeader(listId);
    }else{
      row.classList.add('removing');
      setTimeout(()=>{row.remove();if(!subGroup.children.length)subGroup.remove();},200);
    }
  };
  input.addEventListener('blur',commit);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();input.blur();}
    if(e.key==='Escape'){input.value='';input.blur();}
  });
  row.querySelector('.chat-todo-del').addEventListener('click',()=>{input.value='';input.blur();});
  requestAnimationFrame(()=>input.focus());
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
    blocks.push(`<div class="mermaid-container" data-mindmap-id="${mindId}"><div class="mermaid-toolbar"><a class="mm-download" href="#" onclick="return false">Download PNG</a></div><pre class="mermaid">${restored}</pre></div>`);
    // Auto-open in canvas so user can interact with it
    if(!_suppressCanvasAutoOpen) setTimeout(()=>openMindMapCanvas(mindId),150);
    return `%%%BLOCK${blocks.length-1}%%%`;
  });
  // Interactive todo lists
  let _todoBlockIdx=0;
  t=t.replace(/```todolist\n([\s\S]*?)```/g,(_,c)=>{
    const raw=c.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
    try{
      const items=JSON.parse(raw);
      if(Array.isArray(items)){
        const chatPrefix=curChat||'nochat';
        const listId='tl_'+chatPrefix+'_'+(_todoBlockIdx++);
        // Remove old list with same ID to prevent duplicates
        const oldEl=document.querySelector(`.chat-todo[data-list-id="${listId}"]`);
        if(oldEl)oldEl.remove();
        chatTodoStore.set(listId,items.map((it,i)=>({id:listId+'_'+i,text:it.text||'',done:!!it.done,subtasks:(it.subtasks||[]).map((sub,j)=>({id:listId+'_'+i+'_s'+j,text:sub.text||'',done:!!sub.done}))})));
        syncChatTodosToStorage(listId);
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
    window['_cblkLang'+bid]=l||'code';
    blocks.push(`<pre style="background:var(--bg-deep);padding:14px 16px;border-radius:var(--r-sm);overflow-x:auto;font-family:var(--mono);font-size:11.5px;margin:10px 0;border:1px solid var(--border);line-height:1.65"><code>${c}</code></pre>`);
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
  // Bare URLs — auto-link any https?:// not already inside an <a> tag
  t=t.replace(/(?<!href=")(?<!src=")(?<!">)(https?:\/\/[^\s<"']+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>');
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
  document.getElementById('dataChats').innerHTML=(d.chats||[]).map(c=>`<div style="padding:2px 0">${esc(c.title)} (${c.messages} msgs)</div>`).join('')||'None';
}

async function resetData(){
  const step1=await _dlg({title:'Delete your account?',msg:'Are you sure? This will permanently delete your account, all your chats, memory, settings, and uploaded files. This cannot be undone.',icon:'🔥',iconType:'danger',confirmText:'Yes, delete my account',cancelText:'Cancel',dangerous:true});
  if(!step1)return;
  const step2=await _dlg({title:'Final confirmation',msg:'Last chance — this will permanently erase everything. There is no way to recover your data.',icon:'🔥',iconType:'danger',confirmText:'Permanently delete',cancelText:'Cancel',dangerous:true});
  if(!step2)return;
  const r=await fetch('/api/auth/data',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  const d=await r.json();
  if(d.ok){
    // Clear all local storage
    localStorage.removeItem('gyro_uid');
    localStorage.removeItem('gyro_remember');
    localStorage.removeItem('gyro_guest_id');
    localStorage.removeItem('gyro_theme_override');
    localStorage.removeItem(LAST_SEEN_VERSION_KEY);
    localStorage.removeItem(ONB_SKIP_KEY);
    localStorage.removeItem(ONB_NO_REMIND_KEY);
    localStorage.removeItem(ONB_DISMISS_KEY);
    localStorage.removeItem(HOME_WIDGET_CACHE_KEY);
    localStorage.removeItem(CHAT_CACHE_KEY);
    try{localStorage.removeItem('gyro_productivity');}catch{}
    closeM('settingsModal');
    curChat=null;curUser=null;
    document.getElementById('appPage').classList.remove('visible');
    document.getElementById('loginPage').style.display='flex';
    showToast('Account deleted.','success');
  }else{
    await _dlg({title:'Deletion failed',msg:d.error||'Something went wrong.',icon:'✕',iconType:'danger',confirmText:'OK'});
  }
}

async function deleteAllChats(){
  const count=allChats.length;
  if(!count){showToast('No chats to delete.','info');return;}
  const ok=await _dlg({title:`Delete all ${count} chats?`,msg:`This will permanently delete every chat. Your memory, settings, and account will not be affected.`,icon:'🔥',iconType:'danger',confirmText:`Delete all ${count} chats`,cancelText:'Cancel',dangerous:true});
  if(!ok)return;
  await fetch('/api/chats/delete-all',{method:'POST'});
  curChat=null;
  document.getElementById('topTitle').textContent='gyro';
  document.getElementById('chatArea').innerHTML='';
  await refreshChats();
  loadWelcome(true);
  showToast(`All ${count} chats deleted.`,'success');
}

// ─── Files ────────────────────────────────────────
async function openFiles(){
  document.getElementById('settingsModal').classList.add('open');
  const r=await fetch('/api/files');const d=await r.json();
  document.getElementById('filesList').innerHTML=(d.files||[]).map(f=>
    `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div style="font-size:12px;color:var(--text-primary);font-weight:500">${esc(f.path)}</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${f.size.toLocaleString()} chars</div></div>`
  ).join('')||'<div style="color:var(--text-muted);font-size:11px">No workspace files found.</div>';
}

// ─── File Browser ─────────────────────────────────
function openFileBrowser(){
  document.getElementById('fileBrowser').classList.add('open');
  document.getElementById('fileBrowserOverlay').classList.add('open');
  refreshFileBrowser();
}
function closeFileBrowser(){
  document.getElementById('fileBrowser').classList.remove('open');
  document.getElementById('fileBrowserOverlay').classList.remove('open');
}
function switchFileTab(tab,btn){
  document.querySelectorAll('.fb-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.fb-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(tab==='chat'?'fbChat':'fbWorkspace').classList.add('active');
  if(tab==='chat')refreshChatFiles();else refreshWorkspaceFiles();
}
async function refreshFileBrowser(){
  refreshWorkspaceFiles();
  refreshChatFiles();
}
async function refreshWorkspaceFiles(){
  const el=document.getElementById('fbWorkspace');
  if(!el)return;
  try{
    const r=await fetch('/api/user-files');
    const d=await r.json();
    const files=d.files||[];
    if(!files.length){el.innerHTML='<div class="fb-empty">No files yet. The AI will create files here as you work.</div>';return;}
    const folders={};
    files.forEach(f=>{const fld=f.folder||'';if(!folders[fld])folders[fld]=[];folders[fld].push(f);});
    let html='';
    const sortedFolders=['',...Object.keys(folders).filter(f=>f).sort()];
    for(const fld of sortedFolders){
      if(!folders[fld])continue;
      if(fld){
        html+=`<div class="fb-folder"><div class="fb-folder-head" onclick="this.parentElement.classList.toggle('collapsed')"><span class="fb-folder-arrow">▾</span><span class="fb-folder-icon" style="color:var(--accent)">▸</span><span class="fb-folder-name">${esc(fld)}</span><span class="fb-folder-count">${folders[fld].length}</span><button class="fb-del" onclick="event.stopPropagation();deleteUserFile('${encodeURIComponent(fld)}',true)" title="Delete folder">✕</button></div><div class="fb-folder-body">`;
      }
      for(const f of folders[fld]){
        const ext=(f.name.split('.').pop()||'').toLowerCase();
        const icon=ext==='md'?'◆':ext==='json'?'◇':ext==='txt'?'▪':ext==='yaml'||ext==='yml'?'▫':'▪';
        html+=`<div class="fb-file" onclick="openWorkspaceFile('${encodeURIComponent(f.path)}')"><span class="fb-file-icon">${icon}</span><span class="fb-file-name">${esc(f.name)}</span><span class="fb-file-size">${formatFileSize(f.size)}</span><button class="fb-del" onclick="event.stopPropagation();deleteUserFile('${encodeURIComponent(f.path)}')" title="Delete">✕</button></div>`;
      }
      if(fld)html+=`</div></div>`;
    }
    el.innerHTML=html;
  }catch{el.innerHTML='<div class="fb-empty">Could not load files.</div>';}
}
function formatFileSize(bytes){
  if(bytes<1024)return bytes+'B';
  if(bytes<1048576)return(bytes/1024).toFixed(1)+'KB';
  return(bytes/1048576).toFixed(1)+'MB';
}
async function refreshChatFiles(){
  const el=document.getElementById('fbChat');
  if(!el)return;
  if(!curChat){el.innerHTML='<div class="fb-empty">Open a chat to see its files.</div>';return;}
  const chat=allChats.find(c=>c.id===curChat);
  // We need full chat data with generated_files
  try{
    const r=await apiFetch(`/api/chats/${curChat}`);
    if(!r.ok){el.innerHTML='<div class="fb-empty">Could not load chat.</div>';return;}
    const data=await r.json();
    const genFiles=data.generated_files||[];
    const uploads=(data.messages||[]).filter(m=>m.file_name).map(m=>({name:m.file_name,when:m.timestamp}));
    let html='';
    if(genFiles.length){
      html+='<div class="fb-section-title">Generated Files</div>';
      for(const f of genFiles){
        const name=f.path.split('/').pop()||f.path;
        html+=`<div class="fb-file" onclick="openWorkspaceFile('${encodeURIComponent(f.path)}')"><span class="fb-file-icon">◆</span><span class="fb-file-name">${esc(name)}</span><span class="fb-file-size">${esc(f.action)}</span></div>`;
      }
    }
    if(uploads.length){
      html+='<div class="fb-section-title">Uploaded Files</div>';
      for(const u of uploads){
        html+=`<div class="fb-file"><span class="fb-file-icon">▪</span><span class="fb-file-name">${esc(u.name)}</span><span class="fb-file-size">${new Date(u.when).toLocaleDateString()}</span></div>`;
      }
    }
    if(!html)html='<div class="fb-empty">No files in this chat yet.</div>';
    el.innerHTML=html;
  }catch{el.innerHTML='<div class="fb-empty">Could not load chat files.</div>';}
}
async function createUserFolder(){
  const name=await _dlg({title:'New folder',msg:'',icon:'▸',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. notes/research, projects/web…',confirmText:'Create',cancelText:'Cancel'});
  if(!name?.trim())return;
  await fetch('/api/user-files/folder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:name.trim()})});
  refreshWorkspaceFiles();
  showToast('Folder created.','success');
}
async function deleteUserFile(encodedPath,isFolder){
  const path=decodeURIComponent(encodedPath);
  const type=isFolder?'folder and all its contents':'file';
  const ok=await _dlg({title:`Delete ${type}?`,msg:`Are you sure you want to delete "${path}"?`,icon:'▸',iconType:'warn',confirmText:'Delete',cancelText:'Cancel'});
  if(!ok)return;
  await fetch('/api/user-files/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
  refreshWorkspaceFiles();
  showToast('Deleted.','success');
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
    closeFileBrowser();
  }catch{
    showToast('Could not open file.','error');
  }
}

// ─── Chat Settings Drawer ──────────────────────────
function openChatDrawer(){
  if(!curChat){showToast('Open a chat first.','info');return;}
  document.getElementById('chatDrawer').classList.add('open');
  document.getElementById('chatDrawerOverlay').classList.add('open');
  loadChatDrawer();
}
function closeChatDrawer(){
  document.getElementById('chatDrawer').classList.remove('open');
  document.getElementById('chatDrawerOverlay').classList.remove('open');
}
async function loadChatDrawer(){
  try{
    const r=await apiFetch(`/api/chats/${curChat}`);
    if(!r.ok)return;
    const chat=await r.json();
    document.getElementById('chatInstructions').value=chat.custom_instructions||'';
    // Render pinned files
    const pinnedEl=document.getElementById('pinnedFilesList');
    const pinned=chat.pinned_files||[];
    pinnedEl.innerHTML=pinned.length
      ?pinned.map(p=>{const path=typeof p==='string'?p:p.path;return`<div class="cd-pinned-item"><span>▪ ${esc(path)}</span><button onclick="unpinFile('${encodeURIComponent(path)}')" title="Unpin">✕</button></div>`;}).join('')
      :'<div class="fb-empty">No pinned files.</div>';
    // Populate folder select
    const sel=document.getElementById('chatFolderSelect');
    const foldersR=await fetch('/api/folders');
    const foldersD=await foldersR.json();
    const folders=foldersD.folders||[];
    sel.innerHTML='<option value="">No folder</option>'+folders.map(f=>`<option value="${esc(f)}"${chat.folder===f?' selected':''}>${esc(f)}</option>`).join('');
  }catch{}
}
async function saveChatInstructions(){
  const val=document.getElementById('chatInstructions').value;
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({custom_instructions:val})});
  showToast('Instructions saved.','success');
}
async function openPinFilePicker(){
  try{
    const r=await fetch('/api/user-files');
    const d=await r.json();
    const files=d.files||[];
    if(!files.length){showToast('No files to pin.','info');return;}
    const list=files.map(f=>f.path).join('\n');
    const chosen=await _dlg({title:'Pin a file',msg:'Available: '+files.map(f=>f.path).join(', '),icon:'▸',iconType:'info',inputLabel:'File path',inputDefault:files[0]?.path||'',inputPlaceholder:'e.g. notes/research/topic.md',confirmText:'Pin',cancelText:'Cancel'});
    if(!chosen?.trim())return;
    // Fetch current chat to get existing pins
    const cr=await apiFetch(`/api/chats/${curChat}`);
    const chat=await cr.json();
    const pinned=chat.pinned_files||[];
    const path=chosen.trim();
    if(pinned.some(p=>(typeof p==='string'?p:p.path)===path)){showToast('Already pinned.','info');return;}
    pinned.push(path);
    await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned_files:pinned})});
    loadChatDrawer();
    showToast('File pinned.','success');
  }catch{showToast('Could not pin file.','error');}
}
async function unpinFile(encodedPath){
  const path=decodeURIComponent(encodedPath);
  const cr=await apiFetch(`/api/chats/${curChat}`);
  const chat=await cr.json();
  const pinned=(chat.pinned_files||[]).filter(p=>(typeof p==='string'?p:p.path)!==path);
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned_files:pinned})});
  loadChatDrawer();
  showToast('File unpinned.','success');
}
async function moveChatToFolder(folder){
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
  await refreshChats();
  showToast(folder?`Moved to ${folder}.`:'Removed from folder.','success');
}
async function createAndMoveFolder(){
  const name=await _dlg({title:'New folder',msg:'',icon:'▸',iconType:'info',inputLabel:'Folder name',inputDefault:'',inputPlaceholder:'e.g. Work, Projects…',confirmText:'Create & Move',cancelText:'Cancel'});
  if(!name?.trim())return;
  await fetch(`/api/chats/${curChat}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder:name.trim()})});
  await refreshChats();
  loadChatDrawer();
  showToast(`Moved to ${name.trim()}.`,'success');
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
let canvasSelection=null; // {start,end,text} from user selection in canvas editor
let _suppressCanvasAutoOpen=false; // true during history load to prevent auto-opening

function renderCanvasTabs(){
  const tabsEl=document.getElementById('canvasTabs');
  if(!tabsEl)return;
  tabsEl.innerHTML=canvasTabs.map(t=>`<button class="canvas-tab ${t.id===activeCanvasTabId?'active':''}" onclick="switchCanvasTab('${t.id}')">${esc(t.title||'Document')}</button>`).join('');
}

function detectCanvasLang(title){
  if(!title)return '';
  const ext=(title.match(/\.(\w+)$/)||[])[1];
  if(ext)return ext.toLowerCase();
  return '';
}

function switchCanvasTab(id){
  const tab=canvasTabs.find(t=>t.id===id);
  if(!tab)return;
  activeCanvasTabId=id;
  canvasIsCode=!!tab.isCode;
  const panel=document.getElementById('canvasPanel');
  const editor=document.getElementById('canvasEditor');
  const langEl=document.getElementById('canvasLang');
  const titleEl=document.getElementById('canvasTitle');
  const runBtn=document.getElementById('canvasRunBtn');
  editor.value=tab.content||'';
  editor.className=tab.isCode?'canvas-editor code-mode':'canvas-editor';
  const lang=detectCanvasLang(tab.title);
  langEl.textContent=lang||( tab.isCode?'code':'');
  titleEl.textContent=tab.title||'Document';
  // Show run button for Python and HTML
  const runnable=['py','python','html','htm'].includes(lang);
  runBtn.style.display=runnable?'flex':'none';
  renderCanvasTabs();
  updateCanvasStats();
  closeCanvasOutput();
  panel.classList.add('open');
  document.getElementById('canvasResizer').classList.add('visible');
  editor.focus();
  canvasSelection=null;
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
  closeCanvasOutput();
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

// ─── Canvas select-to-edit ────────────────────────
(function initCanvasSelectToEdit(){
  const editor=document.getElementById('canvasEditor');
  if(!editor)return;
  let hintEl=null;
  function ensureHint(){
    if(hintEl)return hintEl;
    hintEl=document.createElement('div');
    hintEl.className='canvas-selection-hint';
    hintEl.textContent='Type in chat to edit selection';
    editor.parentElement.appendChild(hintEl);
    return hintEl;
  }
  editor.addEventListener('mouseup',()=>{
    const s=editor.selectionStart,e=editor.selectionEnd;
    if(s!==e){
      canvasSelection={start:s,end:e,text:editor.value.substring(s,e)};
      const hint=ensureHint();
      hint.classList.add('visible');
      setTimeout(()=>hint.classList.remove('visible'),2500);
    }else{
      canvasSelection=null;
    }
  });
  editor.addEventListener('keyup',()=>{
    const s=editor.selectionStart,e=editor.selectionEnd;
    if(s===e)canvasSelection=null;
  });
})();

function copyCanvas(){
  const text=document.getElementById('canvasEditor').value;
  navigator.clipboard.writeText(text).then(()=>showToast('Copied to clipboard','success'));
}

function downloadCanvas(){
  const text=document.getElementById('canvasEditor').value;
  const rawTitle=document.getElementById('canvasTitle').textContent||'document';
  const hasExt=/\.\w+$/.test(rawTitle);
  const fname=hasExt?rawTitle:(rawTitle.replace(/[^a-zA-Z0-9._-]/g,'_')+(canvasIsCode?'.txt':'.md'));
  const blob=new Blob([text],{type:'text/plain'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=fname;a.click();
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

// ─── Canvas presets ───────────────────────────────
function toggleCanvasPresets(){
  const popup=document.getElementById('canvasPresetsPopup');
  popup.classList.toggle('open');
  if(popup.classList.contains('open')){
    const close=e=>{if(!popup.contains(e.target)&&e.target.id!=='canvasPresetsBtn'){popup.classList.remove('open');document.removeEventListener('click',close);}};
    setTimeout(()=>document.addEventListener('click',close),0);
  }
}

async function canvasPresetEdit(type){
  document.getElementById('canvasPresetsPopup').classList.remove('open');
  const editor=document.getElementById('canvasEditor');
  const content=editor.value;
  if(!content.trim()){showToast('Canvas is empty','info');return;}
  const presetMap={
    shorter:'Make this significantly shorter and more concise while keeping key information.',
    longer:'Expand this with more detail, examples, and explanation.',
    emojis:'Add relevant emojis throughout to make it more expressive and fun.',
    professional:'Rewrite in a professional, polished tone suitable for business communication.',
    casual:'Rewrite in a casual, conversational tone.',
    fix_grammar:'Fix all grammar, spelling, and punctuation errors.',
    simplify:'Simplify the language to make it easier to understand.',
    bullet_points:'Convert this into a well-organized bullet point format.',
    add_comments:'Add helpful code comments explaining what each section does.',
    optimize:'Optimize this code for better performance and cleaner structure.'
  };
  const instruction=presetMap[type]||type;
  const lang=document.getElementById('canvasLang').textContent||'text';
  document.getElementById('canvasStatus').textContent='AI is editing...';
  try{
    const r=await apiFetch('/api/canvas/apply',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content,instruction,language:lang})});
    const d=await r.json();
    if(d.error){document.getElementById('canvasStatus').textContent='Edit failed';showToast(d.error,'error');return;}
    editor.value=d.content||'';
    const tab=canvasTabs.find(t=>t.id===activeCanvasTabId);
    if(tab)tab.content=editor.value;
    updateCanvasStats();
    document.getElementById('canvasStatus').textContent='Edit applied';
    showToast('Canvas updated','success');
  }catch(e){
    document.getElementById('canvasStatus').textContent='Edit failed';
    showToast('AI edit failed','error');
  }
}

// ─── Canvas run / preview ─────────────────────────
function closeCanvasOutput(){
  const el=document.getElementById('canvasRunOutput');
  if(el)el.style.display='none';
  const body=document.getElementById('canvasRunBody');
  if(body)body.innerHTML='';
}

async function runCanvasCode(){
  const code=document.getElementById('canvasEditor').value;
  if(!code.trim()){showToast('Nothing to run','info');return;}
  const lang=detectCanvasLang(document.getElementById('canvasTitle').textContent||'');
  const outputEl=document.getElementById('canvasRunOutput');
  const bodyEl=document.getElementById('canvasRunBody');
  outputEl.style.display='flex';
  bodyEl.innerHTML='<span style="color:var(--text-muted)">Running...</span>';

  if(['html','htm'].includes(lang)){
    // HTML preview via sandboxed iframe
    const iframe=document.createElement('iframe');
    iframe.sandbox='allow-scripts';
    iframe.style.cssText='width:100%;height:100%;border:none;border-radius:var(--r-sm);background:#fff;min-height:220px';
    bodyEl.innerHTML='';
    bodyEl.appendChild(iframe);
    iframe.srcdoc=code;
    return;
  }

  if(['py','python'].includes(lang)){
    try{
      const r=await apiFetch('/api/canvas/run',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code,language:'python'})});
      const d=await r.json();
      if(d.error){bodyEl.textContent='Error: '+d.error;return;}
      bodyEl.textContent=d.output||'(no output)';
    }catch(e){
      bodyEl.textContent='Failed to run: '+e.message;
    }
    return;
  }
  bodyEl.textContent='Run not supported for this file type.';
}

// ─── Canvas: get selection context for main chat ──
function getCanvasContext(){
  const panel=document.getElementById('canvasPanel');
  if(!panel||!panel.classList.contains('open'))return null;
  const editor=document.getElementById('canvasEditor');
  const title=document.getElementById('canvasTitle').textContent||'Document';
  const content=editor.value;
  if(!content.trim())return null;
  if(canvasSelection&&canvasSelection.text){
    return {title,fullContent:content,selectedText:canvasSelection.text,selStart:canvasSelection.start,selEnd:canvasSelection.end};
  }
  return {title,fullContent:content,selectedText:null,selStart:null,selEnd:null};
}

function openMindMapCanvas(mindId){
  const item=mindMapStore.get(mindId);
  if(!item)return;
  openCanvas(item.source,(item.title||'mindmap')+'.mmd',true,{openPanel:true});
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

const PRODUCTIVITY_KEY='gyro_productivity_v1';

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
  refreshHomeWidgets();
}

function toggleTodoItem(id){
  const state=loadProductivityState();
  const item=state.todos.find(t=>t.id===id);
  if(!item)return;
  item.done=!item.done;
  saveProductivityState(state);
  renderProductivityHub();
  refreshHomeWidgets();
}

function deleteTodoItem(id){
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>t.id!==id);
  saveProductivityState(state);
  renderProductivityHub();
  refreshHomeWidgets();
}

function toggleHomeTodo(id){
  const state=loadProductivityState();
  const item=state.todos.find(t=>t.id===id);
  if(!item)return;
  item.done=!item.done;
  saveProductivityState(state);
  refreshHomeWidgets();
}

function deleteHomeTodo(id){
  const state=loadProductivityState();
  state.todos=state.todos.filter(t=>t.id!==id);
  saveProductivityState(state);
  refreshHomeWidgets();
}

function refreshHomeWidgets(){
  if(!curChat)loadWelcome(true);
}

function handleNudgeAction(btn){
  const item=btn.closest('.wl-nudge-item');
  if(!item)return;
  try{
    const action=JSON.parse(item.dataset.nudgeAction||'{}');
    if(action.type==='open_chat'&&action.chat_id){
      openChat(action.chat_id);
    }else if(action.type==='prompt'&&action.text){
      fillMasterPrompt(action.text);
    }
  }catch{}
}

function _detectClientFriction(){
  const nudges=[];
  const now=Date.now();
  // Stale chats: updated > 3 days ago with real messages
  for(const c of (allChats||[])){
    const updated=c.updated||c.created||'';
    const msgCount=c.message_count||0;
    if(!updated||msgCount<2)continue;
    try{
      const days=Math.floor((now-new Date(updated).getTime())/(86400000));
      if(days>=3){
        nudges.push({
          category:'stale_chat',
          message:`"${c.title||'Untitled'}" — untouched for ${days} day${days!==1?'s':''}`,
          next_step:'Review where you left off and decide: continue, archive, or close it out.',
          action:{type:'open_chat',chat_id:c.id||''},
        });
      }
    }catch{}
  }
  nudges.sort((a,b)=>{
    const da=parseInt((a.message.match(/(\d+)\s*day/)||[])[1]||'0');
    const db=parseInt((b.message.match(/(\d+)\s*day/)||[])[1]||'0');
    return db-da;
  });
  const stale=nudges.slice(0,2);
  // Task overload
  const state=loadProductivityState();
  const todos=state.todos||[];
  const pending=todos.filter(t=>!t.done);
  if(pending.length>=6){
    stale.push({
      category:'task_overload',
      message:`${pending.length} open tasks — time to triage`,
      next_step:'Pick the 1-2 that actually move the needle today and defer the rest.',
      action:{type:'prompt',text:'Help me triage my open tasks and pick the top priorities for today'},
    });
  }
  // Scope creep: many tasks, very few completed
  const doneCount=todos.filter(t=>t.done).length;
  if(todos.length>=8&&doneCount<todos.length*0.2){
    stale.push({
      category:'scope_creep',
      message:`Only ${doneCount}/${todos.length} tasks completed — adding faster than finishing`,
      next_step:'Consider trimming low-value tasks or breaking big ones into smaller wins.',
      action:{type:'prompt',text:'Help me identify which tasks I can cut or defer — I\'m adding faster than finishing'},
    });
  }
  return stale.slice(0,5);
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
    flowchart:{curve:'basis',htmlLabels:true,nodeSpacing:60,rankSpacing:70,padding:22},
    mindmap:{padding:24,maxNodeWidth:220},
    themeVariables:light?{
      primaryColor:'#fdf6ef',
      primaryTextColor:'#1a1410',
      primaryBorderColor:'#d4a574',
      lineColor:'#c9956a',
      secondaryColor:'#f0e1d0',
      tertiaryColor:'#e8d5c0',
      fontSize:'14px',
      fontFamily:'Inter, Segoe UI, sans-serif',
      nodeBorder:'#d4a574',
      mainBkg:'#fdf6ef',
      clusterBkg:'#f5e8da',
      edgeLabelBackground:'#f3e7d8',
    }:{
      primaryColor:'#1e1b24',
      primaryTextColor:'#ede6df',
      primaryBorderColor:'#c97b42',
      lineColor:'#8b6b50',
      secondaryColor:'#252130',
      tertiaryColor:'#2a1f16',
      fontSize:'14px',
      fontFamily:'Inter, Segoe UI, sans-serif',
      nodeBorder:'#7a5d46',
      mainBkg:'#1a1722',
      clusterBkg:'#16131e',
      edgeLabelBackground:'#121014',
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