'use strict';

const fs = require('fs');
const path = require('path');

function projectsFile() {
  return path.resolve(process.env.PROJECTS_FILE || './config/projects.json');
}

function loadRegistry() {
  // Sur Orkestr (conteneur) : registre inline via env PROJECTS_JSON (prioritaire sur le fichier).
  if (process.env.PROJECTS_JSON) {
    try {
      return { file: '(env PROJECTS_JSON)', projects: JSON.parse(process.env.PROJECTS_JSON), error: null };
    } catch (err) {
      return { file: '(env PROJECTS_JSON)', projects: {}, error: 'PROJECTS_JSON invalide: ' + String(err && err.message || err) };
    }
  }
  const file = projectsFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, projects: raw, error: null };
  } catch (err) {
    return { file, projects: {}, error: String(err && err.message || err) };
  }
}

function saveRegistry(projects) {
  fs.writeFileSync(projectsFile(), JSON.stringify(projects, null, 2) + '\n', 'utf8');
}

function getProject(name) {
  const { projects } = loadRegistry();
  return projects[name] || null;
}

function listProjects() {
  const { file, projects, error } = loadRegistry();
  return {
    file,
    error,
    items: Object.entries(projects).map(([name, cfg]) => ({
      name,
      path: cfg.path,
      description: cfg.description || '',
      url: cfg.url || '',
      exists: cfg.path ? fs.existsSync(cfg.path) : false,
    })),
  };
}

/** Garde-fou : le chemin résolu doit correspondre exactement à un projet du registre. */
function resolveProjectPath(name) {
  const cfg = getProject(name);
  if (!cfg || !cfg.path) throw new Error(`projet inconnu: ${name}`);
  const abs = path.resolve(cfg.path);
  // Optionnel : restreindre à ALLOWED_ROOTS si défini
  const roots = (process.env.ALLOWED_ROOTS || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (roots.length > 0) {
    const ok = roots.some((r) => abs.toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep) || abs.toLowerCase() === path.resolve(r).toLowerCase());
    if (!ok) throw new Error(`chemin projet hors racines autorisées: ${abs}`);
  }
  return { config: cfg, absPath: abs };
}

function buildContextLock(projectName, absPath) {
  return `Tu es un agent de développement limité STRICTEMENT au répertoire ${absPath}. Tu ne dois jamais modifier de fichiers en dehors de ce dossier ni exécuter de commandes destructrices système. Projet cible : ${projectName}.`;
}

// Motifs destructeurs système — rejet pré-exécution (garde-fou, pas une sandbox kernel).
const FORBIDDEN = [
  /rm\s+-rf\s+\/(?!\s*$)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\|\:&\s*;\s*\}/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bformat\s+[a-z]:/i,
  /Remove-Item\s+.*-Recurse.*C:\\Windows/i,
];

function scanInstruction(instruction) {
  const hits = FORBIDDEN.filter((re) => re.test(instruction || '')).map((re) => String(re));
  return hits;
}

module.exports = {
  loadRegistry, saveRegistry, getProject, listProjects,
  resolveProjectPath, buildContextLock, scanInstruction,
};
