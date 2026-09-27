'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveProjectPath } = require('./projects');

function ts() { return new Date().toISOString(); }
function emit(broadcast, jobId, type, data = {}) {
  broadcast({ jobId, type, ts: ts(), ...data });
}

function hasScript(absPath, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(absPath, 'package.json'), 'utf8'));
    return Boolean(pkg.scripts && pkg.scripts[name]);
  } catch { return false; }
}

function pm2Available() {
  const probe = spawnSync('pm2', ['--version'], { shell: true, timeout: 10000 });
  return probe.status === 0;
}

function execStream(cmd, cwd, onLog) {
  return new Promise((resolve) => {
    onLog(`[deploy] $ ${cmd} (cwd=${cwd})`);
    const child = spawn(cmd, [], { cwd, shell: true, windowsHide: true });
    child.stdout.on('data', (d) => onLog(d.toString()));
    child.stderr.on('data', (d) => onLog('[stderr] ' + d.toString()));
    child.on('error', (err) => { onLog(`[deploy] erreur spawn: ${err.message}`); resolve({ ok: false, exitCode: -1 }); });
    child.on('close', (code) => { onLog(`[deploy] exit=${code} :: ${cmd}`); resolve({ ok: code === 0, exitCode: code }); });
  });
}

/** Build + reload auto : `npm run build && pm2 restart [PROJECT]` (dégradé propre si indisponible). */
async function runDeploy({ project, jobId, user }, broadcast) {
  const { config, absPath } = resolveProjectPath(project);
  const onLog = (line) => emit(broadcast, jobId, 'log', { project, stream: 'deploy', data: String(line) });
  emit(broadcast, jobId, 'status', { project, status: 'deploying', message: 'Build + rechargement automatique' });

  if (!fs.existsSync(absPath)) {
    const msg = `dossier projet introuvable: ${absPath}`;
    onLog(`[deploy] ${msg}`);
    emit(broadcast, jobId, 'deployed', { project, ok: false, error: msg, url: config.url || '' });
    return { ok: false, error: msg };
  }

  let build = { ok: true, skipped: true };
  if (hasScript(absPath, 'build')) {
    const buildCmd = (config.deploy && config.deploy.build) || 'npm run build';
    build = await execStream(buildCmd, absPath, onLog);
  } else {
    onLog('[deploy] aucun script "build" (package.json absent ou sans build) — étape ignorée');
  }

  let restart = { ok: true, skipped: true };
  const restartCmd = config.deploy && config.deploy.restart;
  if (restartCmd) {
    if (restartCmd.startsWith('pm2 ') && !pm2Available()) {
      onLog('[deploy] pm2 introuvable — redémarrage ignoré (installez pm2: npm i -g pm2). Build conservé.');
    } else {
      restart = await execStream(restartCmd, absPath, onLog);
    }
  } else {
    onLog('[deploy] aucune commande restart configurée — étape ignorée');
  }

  const ok = (build.ok !== false) && (restart.ok !== false);
  emit(broadcast, jobId, 'deployed', {
    project, ok,
    build: build.exitCode ?? null, restart: restart.exitCode ?? null,
    url: config.url || '',
    message: ok ? `Projet à jour${config.url ? ' : ' + config.url : ''}` : 'Déploiement en échec — voir logs',
  });
  return { ok, build, restart, url: config.url || '' };
}

module.exports = { runDeploy };
