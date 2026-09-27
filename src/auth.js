'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

function loadTokens() {
  const set = new Set();
  const envTokens = (process.env.GATEWAY_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  envTokens.forEach((t) => set.add(t));

  // Fichier optionnel config/tokens.json : ["token1", ...] ou { "tokens": [...] }
  const candidates = [
    path.resolve(__dirname, '../config/tokens.json'),
    path.resolve(process.cwd(), 'config/tokens.json'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const arr = Array.isArray(raw) ? raw : raw.tokens;
        if (Array.isArray(arr)) arr.forEach((t) => String(t).trim() && set.add(String(t).trim()));
      }
    } catch {
      // ignore fichier invalide
    }
  }
  return set;
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-access-token']) return String(req.headers['x-access-token']).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  if (req.body && req.body.token) return String(req.body.token).trim();
  return '';
}

function authMiddleware(req, res, next) {
  // Santé + UI publique : pas d'auth. Tout /api/* sauf /api/health : auth requise.
  if (req.path === '/api/health') return next();
  if (!req.path.startsWith('/api/')) return next();
  // /api/auth/verify gère lui-même son contrôle (mais exige quand même un token valide ou à tester)
  const tokens = loadTokens();
  const token = extractToken(req);
  if (token && tokens.has(token)) {
    req.authToken = token;
    req.authUser = req.headers['x-user'] || req.body?.user || req.query?.user || 'collaborateur';
    return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized: token invalide ou manquant (header Authorization: Bearer <token> ou ?token=)' });
}

module.exports = { loadTokens, extractToken, authMiddleware };
