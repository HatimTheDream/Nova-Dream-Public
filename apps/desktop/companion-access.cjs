// Desktop authority is chosen in the native controls, never by a remote tool.
const tools = ['start_session','end_session','launch_app','bring_to_front','list_windows','get_window_state','click','press_key','type_text','scroll','drag','double_click','right_click','hotkey','move_cursor','invoke_menu','set_value','verify_state','get_desktop_state'];
const requiredTools = tools.slice(0, 8);
const active = (until, now = Date.now()) => until === null || Number.isSafeInteger(until) && until > now;
function selection(value, apps) {
  if (!value || !['apps','desktop'].includes(value.scope) || ![15,30,60,'persistent'].includes(value.duration)) throw new Error('Choose the computer access and duration.');
  if (value.scope === 'apps' && !apps.length) throw new Error('Choose at least one Mac app.');
  return { scope: value.scope, duration: value.duration, apps: value.scope === 'apps' ? apps.map(a => ({...a})) : [] };
}
function launchPolicy(grant) {
  const allowed = tools.filter(t => grant.scope === 'desktop' || t !== 'get_desktop_state');
  // Standard already admits ordinary desktop input. Do not bypass the driver's
  // managed policies, protected surfaces or residual approval requirements.
  if (grant.scope === 'desktop') return { mode: 'standard', tools: allowed };
  const lifetime = grant.duration === 'persistent' ? '' : `expires_after: ${grant.duration}m\nidle_timeout: ${grant.duration}m\n`;
  const manifest = `version: 3\n${lifetime}allow:\n  tools:\n${allowed.map(t=>'    - '+t).join('\n')}\nresources:\n  apps:\n${grant.apps.map(a=>'    - executable: '+JSON.stringify(a.executable)+'\n      windows: all\n    - bundle_id: '+JSON.stringify(a.bundleId)+'\n      launch: true\n      windows: all').join('\n')}\n  desktop:\n    display: false\n`;
  return { mode: grant.duration === 'persistent' ? 'standard' : 'bounded', tools: allowed, manifest };
}
function remembered(config) {
  const saved = config.access;
  if (!config.connection || !saved || saved.duration !== 'persistent' || saved.deviceId !== config.connection.deviceId || saved.epoch !== config.connection.epoch || saved.origin !== config.origin) return null;
  if (!Array.isArray(saved.apps) || saved.apps.length > 20 || saved.apps.some(a=>!a || typeof a.name !== 'string' || typeof a.executable !== 'string' || !a.executable.startsWith('/') || !/^[\w.-]+$/.test(a.bundleId))) return null;
  try { return selection(saved, saved.apps); } catch { return null; }
}
module.exports = { tools, requiredTools, active, selection, launchPolicy, remembered };
