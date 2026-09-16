const el = id => document.getElementById(id), api = window.desktopControls;
let busy = false, appNames = '';
const active = until => until === null || until > Date.now();
async function refresh() {
  const state = await api.status();
  if (!el('address').value) el('address').value = state.origin || '';
  el('connection').textContent = state.linked ? `Linked to ${state.origin}${state.error ? ' · reconnect needed' : ''}` : 'Not linked to a workspace yet.';
  const enabled = active(state.enabledUntil), full = state.scope === 'desktop';
  el('access').textContent = enabled ? `${full ? 'Full desktop' : 'Selected apps'} · ${state.enabledUntil === null ? 'On until you turn it off · resumes when you reopen Nova' : 'On until '+new Date(state.enabledUntil).toLocaleTimeString()}` : state.starting ? 'Starting computer access…' : state.remembered ? 'Waiting to reconnect · saved access will resume' : 'Computer access is off.';
  if(enabled || state.remembered){el('scope').value=state.scope;el('minutes').value=state.enabledUntil===null||state.remembered?'persistent':el('minutes').value;}
  const names=JSON.stringify(state.apps);if(names!==appNames){appNames=names;el('app-list').replaceChildren(...state.apps.map(name => { const li = document.createElement('li'); li.textContent = name; return li; }));}
  el('enable').disabled = busy || state.starting || !state.linked || el('scope').value==='apps'&&!state.apps.length || enabled;
  el('apps').disabled = busy || state.starting || state.platform !== 'darwin' || enabled;
  el('scope').disabled=busy||state.starting||enabled;el('minutes').disabled=busy||state.starting||enabled;
  el('app-choice').hidden=el('scope').value==='desktop';
  el('scope-description').textContent=el('scope').value==='desktop'?'Nova can see and operate all apps and the visible desktop, including logged-in services and files reachable through their interfaces.':'Nova can see and operate only the apps you choose. Whole-desktop capture is off.';
  el('duration-description').textContent=el('minutes').value==='persistent'?'Remembered on this computer. Access resumes when you reopen Nova and reconnect to the same workspace. Stop or revoke the link to clear it.':'Access ends automatically. You can stop it sooner at any time.';
  el('forget').disabled = busy || !state.linked;
  if (state.error) el('message').textContent = state.error;
}
async function action(fn) { if (busy) return; busy = true; el('message').textContent = ''; try { await fn(); } catch (e) { el('message').textContent = e.message; } finally { busy = false; await refresh(); } }
el('open').onclick = () => action(() => api.open(el('address').value));
el('apps').onclick = () => action(() => api.chooseApps());
el('enable').onclick = () => action(() => api.enable({scope:el('scope').value,duration:el('minutes').value==='persistent'?'persistent':Number(el('minutes').value)}));
el('scope').onchange=()=>void refresh();el('minutes').onchange=()=>void refresh();
el('stop').onclick = () => action(() => api.stop());
el('forget').onclick = () => action(() => api.forget());
const load = () => refresh().catch(e => { el('message').textContent = e.message; });
void load(); setInterval(() => void load(), 2000);
