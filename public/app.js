'use strict';
const $ = (id) => document.getElementById(id);
const term = $('terminal'), conn = $('conn'), jobEl = $('job');
let ws = null, currentJob = null;

function log(line, cls) {
  const t = new Date().toLocaleTimeString();
  term.textContent += `[${t}] ${line}\n`;
  term.scrollTop = term.scrollHeight;
  if (cls === 'ok') $('deployInfo').textContent = line;
}
function api(path, method = 'GET', body) {
  const token = $('token').value.trim();
  return fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token), {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': $('user').value.trim() || 'collaborateur' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
}
function setConn(on) { conn.textContent = on ? 'connecté' : 'déconnecté'; conn.classList.toggle('on', on); }

async function loadProjects() {
  const { status, data } = await api('/api/projects');
  if (status !== 200) { $('projInfo').textContent = 'Erreur: ' + (data.error || status); return; }
  const sel = $('project'); sel.innerHTML = '';
  data.items.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.name; o.textContent = `${p.name} — ${p.path}${p.exists ? '' : ' (introuvable)'}`;
    sel.appendChild(o);
  });
  updateProjInfo(data.items);
  log(`Projets chargés (${data.items.length}) depuis ${data.file}`);
}
function updateProjInfo(items) {
  const name = $('project').value;
  const p = (items || []).find((x) => x.name === name);
  $('projInfo').textContent = p ? `${p.description || ''} · ${p.path} · ${p.url || 'pas d’URL'} · ${p.exists ? 'dossier OK' : 'DOSSIER INTROUVABLE'}` : '';
}
$('project').addEventListener('change', () => api('/api/projects').then(({ data }) => updateProjInfo(data.items)));
$('reload').onclick = loadProjects;
$('clear').onclick = () => { term.textContent = ''; $('deployInfo').textContent = ''; };

$('create').onclick = async () => {
  const name = $('npName').value.trim(), p = $('npPath').value.trim();
  if (!name || !p) { $('npMsg').textContent = 'Nom et chemin absolu requis.'; return; }
  const body = {
    name, path: p,
    description: $('npDesc').value.trim(),
    url: $('npUrl').value.trim(),
  };
  const build = $('npBuild').value.trim(), restart = $('npRestart').value.trim();
  if (build || restart) body.deploy = { build: build || 'npm run build', restart: restart || '' };
  const { status, data } = await api('/api/projects', 'POST', body);
  if (status !== 200) {
    $('npMsg').textContent = 'Erreur: ' + (data.error || status);
    log('Création projet échouée: ' + (data.error || status));
    return;
  }
  $('npMsg').textContent = `Projet "${data.name}" créé → ${data.path}`;
  log(`Projet créé: ${data.name} → ${data.path}`);
  await loadProjects();
  $('project').value = data.name;
  $('project').dispatchEvent(new Event('change'));
};

$('verify').onclick = async () => {
  const { status, data } = await api('/api/auth/verify', 'POST', {});
  $('authMsg').textContent = status === 200 ? `Token valide — bienvenue ${data.user}` : `Invalide: ${data.error || status}`;
};

$('connect').onclick = () => {
  const token = $('token').value.trim();
  if (!token) { $('authMsg').textContent = 'Saisissez votre clé d’invitation.'; return; }
  localStorage.setItem('orkestr_token', token);
  localStorage.setItem('orkestr_user', $('user').value.trim());
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => { setConn(true); log('WebSocket connecté — streaming en direct actif.'); loadProjects(); };
  ws.onclose = (e) => { setConn(false); log(`WebSocket fermé (${e.code} ${e.reason || ''})`); };
  ws.onerror = () => log('Erreur WebSocket.');
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello') { log(`Gateway: ${m.projects?.length ?? 0} projet(s) disponible(s).`); return; }
    if (m.type === 'log') {
      if (currentJob && m.jobId !== currentJob) { /* on affiche tout, taggé */ }
      log(`[${m.project || '?'}:${m.stream || 'out'}] ${m.data}`.trimEnd());
      return;
    }
    if (m.type === 'status') { currentJob = m.jobId; jobEl.textContent = `job ${m.jobId} · ${m.status} — ${m.message || ''}`; log(`— ${m.status}: ${m.message || ''}`); return; }
    if (m.type === 'done') { jobEl.textContent = `job ${m.jobId} terminé ok=${m.ok}`; log(`— terminé ok=${m.ok} exit=${m.exitCode ?? '?'}${m.simulation ? ' (simulation)' : ''}${m.error ? ' err=' + m.error : ''}`); return; }
    if (m.type === 'deployed') { const s = m.ok ? `DÉPLOYÉ — ${m.message}` : `ÉCHEC DÉPLOIEMENT — ${m.message || m.error}`; log(s); $('deployInfo').textContent = s + (m.url ? ` · ${m.url}` : ''); return; }
    if (m.type === 'projects' && m.items) { log(`Registre mis à jour (${m.items.length} projets).`); loadProjects(); return; }
    if (m.type === 'error') { log('Erreur: ' + m.error); return; }
  };
};

async function sendRun() {
  const project = $('project').value, instruction = $('instruction').value.trim(), user = $('user').value.trim() || 'collaborateur';
  if (!project || !instruction) { log('Sélectionnez un projet et saisissez une instruction.'); return; }
  // Envoi prioritaire via WS (streaming), repli REST si WS fermé.
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'run', project, instruction, user }));
    log(`Ordre envoyé à l’agent [${project}] via WS…`);
  } else {
    const { status, data } = await api('/api/agent/run', 'POST', { project, instruction, user });
    if (status !== 200) log('Erreur: ' + (data.error || status));
    else { currentJob = data.jobId; jobEl.textContent = 'job ' + data.jobId; log(`Agent démarré (REST) job=${data.jobId} — connectez le WS pour le streaming.`); }
  }
}
$('send').onclick = sendRun;

$('rollback').onclick = async () => {
  const project = $('project').value; if (!project) return log('Sélectionnez un projet.');
  if (!confirm(`Rollback instantané (git reset --hard) sur ${project} ?`)) return;
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'rollback', project, user: $('user').value })); log('Rollback demandé via WS…'); }
  else {
    const { data } = await api('/api/agent/rollback', 'POST', { project, user: $('user').value });
    (data.logs || []).forEach((l) => log(l)); log(`Rollback ok=${data.ok}`);
  }
};
$('deploy').onclick = async () => {
  const project = $('project').value; if (!project) return log('Sélectionnez un projet.');
  const { data } = await api('/api/deploy', 'POST', { project, user: $('user').value });
  log(data.message || JSON.stringify(data));
};

// Restaure la session collaborateur
$('token').value = localStorage.getItem('orkestr_token') || '';
$('user').value = localStorage.getItem('orkestr_user') || 'collaborateur';
