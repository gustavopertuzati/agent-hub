'use strict';

/**
 * Orkestr Gateway — agent passerelle (Node.js / Express + WebSockets)
 * Port dédié Orkestr : 4000. Exposition Ngrok : `ngrok http 4000` (allowedHosts: true -> trust proxy + CORS *).
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const { authMiddleware, loadTokens } = require('./auth');
const { listProjects, getProject, resolveProjectPath, saveRegistry, loadRegistry } = require('./projects');
const { jobs, runAgent, rollback } = require('./runner');
const { runDeploy } = require('./deploy');

const PORT = Number(process.env.PORT || 4000);
const app = express();

// --- Exposition Ngrok : accepter les hôtes distants ---
// Express n'a pas de host-check strict par défaut (contrairement à Vite/webpack) :
// on active trust proxy + CORS * pour recevoir les requêtes des collaborateurs via le tunnel.
app.set('trust proxy', true); // équivalent allowedHosts: true derrière ngrok
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token', 'x-user'] }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} host=${req.headers.host || '?'}`);
  next();
});

// --- Auth (tout /api/* sauf /api/health) ---
app.use(authMiddleware);

// --- API ---
app.get('/api/health', (req, res) => {
  const { items } = listProjects();
  res.json({ ok: true, service: 'orkestr-gateway', port: PORT, uptime: process.uptime(), projects: items.length, time: new Date().toISOString() });
});

// Alias healthcheck convention Orkestr (comme open-decks / dice-game : path `/health`)
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'orkestr-gateway', time: new Date().toISOString() });
});

app.get('/api/projects', (req, res) => {
  res.json({ ok: true, ...listProjects() });
});

app.post('/api/projects/reload', (req, res) => {
  res.json({ ok: true, ...listProjects() });
});

app.post('/api/projects', (req, res) => {
  // Ajout dynamique au registre : { name, path, description?, url?, deploy? }
  if (process.env.PROJECTS_JSON) {
    return res.status(409).json({ ok: false, error: 'registre figé par env PROJECTS_JSON (modifiez la variable sur Orkestr)' });
  }
  const { name, path: p, description, url, deploy } = req.body || {};
  if (!name || !p) return res.status(400).json({ ok: false, error: 'name et path requis' });
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return res.status(400).json({ ok: false, error: `chemin introuvable: ${abs}` });
  const { projects } = loadRegistry();
  projects[name] = { path: abs, description: description || '', url: url || '', deploy: deploy || { build: 'npm run build', restart: `pm2 restart ${name}` } };
  saveRegistry(projects);
  broadcast({ type: 'projects', items: listProjects().items });
  res.json({ ok: true, name, path: abs });
});

app.post('/api/auth/verify', (req, res) => {
  res.json({ ok: true, user: req.authUser || 'collaborateur' });
});

// Lancement agent : snapshot git + context lock + `opencode run` + streaming WS + déploiement auto
app.post('/api/agent/run', async (req, res) => {
  const { project, instruction, user } = req.body || {};
  if (!project || !instruction) return res.status(400).json({ ok: false, error: 'project et instruction requis' });
  try { resolveProjectPath(project); } catch (e) { return res.status(404).json({ ok: false, error: String(e.message) }); }
  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, project, user: user || req.authUser, instruction: String(instruction).slice(0, 8000), status: 'queued', startedAt: new Date().toISOString() });
  res.json({ ok: true, jobId, project, message: 'Agent démarré — suivez les logs via WebSocket /ws' });
  // Exécution asynchrone (streaming via WS)
  runAgent({ jobId, project, instruction, user: user || req.authUser }, broadcast).catch((err) => {
    broadcast({ jobId, type: 'done', project, ok: false, error: String(err && err.message || err), ts: new Date().toISOString() });
  });
});

app.post('/api/agent/rollback', async (req, res) => {
  const { project, user } = req.body || {};
  if (!project) return res.status(400).json({ ok: false, error: 'project requis' });
  try { resolveProjectPath(project); } catch (e) { return res.status(404).json({ ok: false, error: String(e.message) }); }
  const jobId = uuidv4();
  const lines = [];
  const result = await rollback(project, user || req.authUser, (l) => { lines.push(l); broadcast({ jobId, type: 'log', project, stream: 'rollback', data: l, ts: new Date().toISOString() }); });
  broadcast({ jobId, type: 'done', project, ok: result.ok, ts: new Date().toISOString() });
  res.json({ ok: result.ok, jobId, ...result, logs: lines });
});

app.post('/api/deploy', async (req, res) => {
  const { project, user } = req.body || {};
  if (!project) return res.status(400).json({ ok: false, error: 'project requis' });
  try { resolveProjectPath(project); } catch (e) { return res.status(404).json({ ok: false, error: String(e.message) }); }
  const jobId = uuidv4();
  res.json({ ok: true, jobId, message: 'Déploiement démarré — logs via WebSocket' });
  runDeploy({ project, jobId, user: user || req.authUser }, broadcast).catch((err) => {
    broadcast({ jobId, type: 'done', project, ok: false, error: String(err && err.message || err), ts: new Date().toISOString() });
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'job inconnu' });
  const { proc, ...safe } = job;
  res.json({ ok: true, job: safe });
});

// --- UI collaborative ---
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// --- WebSockets : terminal en direct ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(data); } catch {} }
  }
}

wss.on('connection', (ws, req) => {
  // Auth WS via ?token= (clé d'invitation collaborateur)
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const tokens = loadTokens();
    if (!tokens.has(token)) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized: token invalide (?token=)' }));
      ws.close(4401, 'unauthorized');
      return;
    }
  } catch { /* si parsing échoue, on laisse passer et le client recevra l'erreur au premier message */ }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', service: 'orkestr-gateway', ts: new Date().toISOString(), projects: listProjects().items }));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { ws.send(JSON.stringify({ type: 'error', error: 'JSON invalide' })); return; }
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
    if (msg.type === 'run') {
      const jobId = uuidv4();
      const { project, instruction, user } = msg;
      try { resolveProjectPath(project); } catch (e) { return ws.send(JSON.stringify({ jobId, type: 'error', error: String(e.message) })); }
      jobs.set(jobId, { id: jobId, project, user, instruction: String(instruction || '').slice(0, 8000), status: 'queued', startedAt: new Date().toISOString() });
      ws.send(JSON.stringify({ jobId, type: 'status', status: 'queued', project }));
      runAgent({ jobId, project, instruction, user }, broadcast).catch((err) => {
        broadcast({ jobId, type: 'done', project, ok: false, error: String(err && err.message || err), ts: new Date().toISOString() });
      });
    }
    if (msg.type === 'rollback') {
      const jobId = uuidv4();
      const { project, user } = msg;
      await rollback(project, user, (l) => broadcast({ jobId, type: 'log', project, stream: 'rollback', data: l, ts: new Date().toISOString() }));
      broadcast({ jobId, type: 'done', project, ok: true, ts: new Date().toISOString() });
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// Rechargement à chaud du registre si le fichier change
try {
  const { file } = loadRegistry();
  fs.watch(path.dirname(file), (evt, name) => {
    if (name === path.basename(file)) broadcast({ type: 'projects', items: listProjects().items, ts: new Date().toISOString() });
  });
} catch {}

server.listen(PORT, '0.0.0.0', () => {
  const { items, error } = listProjects();
  console.log(`Orkestr Gateway en écoute sur http://0.0.0.0:${PORT} (local: http://localhost:${PORT})`);
  console.log(`Projets registés (${items.length}): ${items.map((i) => `${i.name} -> ${i.path} ${i.exists ? '' : '(chemin introuvable)'}`).join(' | ') || '(aucun)'}`);
  if (error && items.length === 0) console.log(`Registre illisible: ${error}`);
  if (!process.env.GATEWAY_TOKENS) console.log('ATTENTION: GATEWAY_TOKENS non défini — utilisez .env (voir .env.example)');
  console.log('Exposition distante: ngrok http 4000');
  const proj = getProject(items[0]?.name);
  void proj;
});
