'use strict';

const { spawn, spawnSync } = require('child_process');
const { resolveProjectPath, buildContextLock, scanInstruction } = require('./projects');
const { runDeploy } = require('./deploy');

const jobs = new Map(); // jobId -> { id, project, user, status, startedAt, finishedAt, exitCode }

function ts() {
  return new Date().toISOString();
}

function emit(broadcast, jobId, type, data = {}) {
  broadcast({ jobId, type, ts: ts(), ...data });
}

function gitSnapshot(cwd, user, onLog) {
  return new Promise((resolve) => {
    const msg = `Pre-agent snapshot by ${user || 'collaborateur'}`;
    // git add -A puis commit (ignore "nothing to commit" / "not a git repo")
    const add = spawnSync('git', ['add', '-A'], { cwd, shell: false });
    onLog(`[snapshot] git add -A (exit=${add.status}) ${(add.stderr || '').toString().trim()}`);
    const c = spawn('git', ['commit', '-am', msg], { cwd, shell: false });
    let out = '';
    c.stdout.on('data', (d) => { out += d; onLog('[snapshot] ' + d.toString().trim()); });
    c.stderr.on('data', (d) => { out += d; onLog('[snapshot] ' + d.toString().trim()); });
    c.on('close', (code) => {
      onLog(`[snapshot] git commit exit=${code}`);
      resolve({ code, out });
    });
    c.on('error', (err) => {
      onLog(`[snapshot] erreur: ${err.message} (dépôt non-git ? snapshot ignoré)`);
      resolve({ code: -1, out: String(err.message) });
    });
  });
}

function opencodeAvailable() {
  const bin = process.env.OPENCODE_BIN || 'opencode';
  const probe = spawnSync(bin, ['--version'], { shell: true, timeout: 10000 });
  return probe.status === 0;
}

/**
 * Exécute l'agent OpenCode CLI dans le cwd du projet, en streamant stdout/stderr.
 * broadcast(msg) -> envoie à tous les clients WS (le server filtre par jobId côté client ou diffuse).
 */
async function runAgent({ jobId, project, instruction, user }, broadcast) {
  const { absPath } = resolveProjectPath(project);
  const job = jobs.get(jobId);
  const onLog = (line, stream = 'stdout') => {
    emit(broadcast, jobId, 'log', { project, stream, data: String(line) });
  };

  const forbidden = scanInstruction(instruction);
  if (forbidden.length > 0) {
    emit(broadcast, jobId, 'status', { project, status: 'rejected', reason: 'instruction bloquée (motif destructeur système)', patterns: forbidden });
    if (job) { job.status = 'rejected'; job.finishedAt = ts(); }
    emit(broadcast, jobId, 'done', { project, ok: false, exitCode:  blockedExit() });
    return { ok: false, reason: 'blocked' };
    function blockedExit() { return 403; }
  }

  if (job) job.status = 'snapshot';
  emit(broadcast, jobId, 'status', { project, status: 'snapshot', message: `Snapshot git pré-agent (${absPath})` });
  await gitSnapshot(absPath, user, onLog);

  const contextLock = buildContextLock(project, absPath);
  const fullPrompt = `${contextLock}\n\nInstruction du collaborateur (${user || 'collaborateur'}) :\n${instruction}`;

  const bin = process.env.OPENCODE_BIN || 'opencode';
  const hasCli = opencodeAvailable();

  if (job) job.status = 'running';
  emit(broadcast, jobId, 'status', {
    project, status: 'running',
    message: hasCli ? `Exécution: ${bin} run (cwd=${absPath})` : `SIMULATION (CLI ${bin} introuvable) — logs simulés, aucune modification réelle`,
    simulation: !hasCli,
  });
  onLog(`[context-lock] ${contextLock}`);

  const timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 600000);

  if (!hasCli) {
    // Mode simulation documenté : permet de valider le pipeline sans la CLI.
    const steps = [
      `[sim] cwd=${absPath}`,
      `[sim] prompt injecté (${fullPrompt.length} caractères)`,
      '[sim] analyse des fichiers du projet…',
      '[sim] génération du patch…',
      '[sim] patch appliqué (simulation — installez OpenCode CLI pour exécution réelle).',
    ];
    for (const s of steps) { onLog(s); await new Promise((r) => setTimeout(r, 400)); }
    if (job) { job.status = 'done'; job.finishedAt = ts(); job.exitCode = 0; job.simulation = true; }
    emit(broadcast, jobId, 'done', { project, ok: true, exitCode: 0, simulation: true });
    // Déploiement auto même en simulation (documenté comme dry-run si package.json absent)
    await runDeploy({ project, jobId, user }, broadcast);
    return { ok: true, simulation: true };
  }

  // EXÉCUTION CLI réelle : `opencode run "<prompt>"` dans le dossier projet (cwd).
  return new Promise((resolve) => {
    const child = spawn(bin, ['run', fullPrompt], { cwd: absPath, shell: true, windowsHide: true });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      onLog(`[timeout] exécution interrompue après ${timeoutMs}ms`, 'stderr');
    }, timeoutMs);
    if (job) job.proc = child;

    child.stdout.on('data', (d) => onLog(d.toString(), 'stdout'));
    child.stderr.on('data', (d) => onLog(d.toString(), 'stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      onLog(`[error] spawn ${bin}: ${err.message}`, 'stderr');
      if (job) { job.status = 'error'; job.finishedAt = ts(); }
      emit(broadcast, jobId, 'done', { project, ok: false, exitCode: -1, error: err.message });
      resolve({ ok: false, error: err.message });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (job) { job.status = killed ? 'timeout' : 'done'; job.finishedAt = ts(); job.exitCode = code; }
      emit(broadcast, jobId, 'done', { project, ok: code === 0 && !killed, exitCode: code, timeout: killed });
      if (code === 0 && !killed) {
        // DEPLOIEMENT & RELANCE AUTOMATIQUE EN PROD
        await runDeploy({ project, jobId, user }, broadcast);
      }
      resolve({ ok: code === 0 && !killed, exitCode: code });
    });
  });
}

function rollback(project, user, onLog) {
  return new Promise((resolve) => {
    const { absPath } = resolveProjectPath(project);
    onLog(`[rollback] git reset --hard (cwd=${absPath}, demandé par ${user || 'collaborateur'})`);
    const child = spawn('git', ['reset', '--hard'], { cwd: absPath, shell: false });
    let out = '';
    child.stdout.on('data', (d) => { out += d; onLog(d.toString().trim()); });
    child.stderr.on('data', (d) => { out += d; onLog(d.toString().trim()); });
    child.on('close', (code) => {
      onLog(`[rollback] exit=${code}`);
      resolve({ ok: code === 0, exitCode: code, out });
    });
    child.on('error', (err) => {
      onLog(`[rollback] erreur: ${err.message}`, 'stderr');
      resolve({ ok: false, error: err.message });
    });
  });
}

module.exports = { jobs, runAgent, rollback };
