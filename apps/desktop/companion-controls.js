const el = id => document.getElementById(id), api = window.desktopControls;
let busy = false;
async function refresh() {
  const state = await api.status();
  if (!el('address').value) el('address').value = state.origin || '';
  el('connection').textContent = state.linked ? `Linked to ${state.origin}${state.error ? ' · reconnect needed' : ''}` : 'Not linked to a workspace yet.';
  el('access').textContent = state.enabledUntil > Date.now() ? `Enabled until ${new Date(state.enabledUntil).toLocaleTimeString()}` : 'Computer access is off.';
  el('app-list').replaceChildren(...state.apps.map(name => { const li = document.createElement('li'); li.textContent = name; return li; }));
  el('enable').disabled = busy || !state.linked || !state.apps.length || state.enabledUntil > Date.now();
  el('apps').disabled = busy || state.platform !== 'darwin' || state.enabledUntil > Date.now();
  el('forget').disabled = busy || !state.linked;
  if (state.error) el('message').textContent = state.error;
}
async function action(fn) { if (busy) return; busy = true; el('message').textContent = ''; try { await fn(); } catch (e) { el('message').textContent = e.message; } finally { busy = false; await refresh(); } }
el('open').onclick = () => action(() => api.open(el('address').value));
el('apps').onclick = () => action(() => api.chooseApps());
el('enable').onclick = () => action(() => api.enable(Number(el('minutes').value)));
el('stop').onclick = () => action(() => api.stop());
el('forget').onclick = () => action(() => api.forget());
const load = () => refresh().catch(e => { el('message').textContent = e.message; });
void load(); setInterval(() => void load(), 2000);
