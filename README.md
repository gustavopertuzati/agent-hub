# Orkestr Gateway — agent passerelle

Pilotage distant des projets de la machine hôte via l'interface Orkestr.
`Express + WebSockets :4000` · `OpenCode CLI sandbox` · `build + pm2` · `rollback` · `ngrok`.

## Démarrage rapide

```bat
cd agent-hub
copy .env.example .env
cmd /c "npm install"
cmd /c "npm start"
```

UI collaborative : http://localhost:4000
Santé : http://localhost:4000/api/health
WS temps réel : `ws://localhost:4000/ws?token=<clé>`

## 1. Registre des projets (`config/projects.json`)

Dictionnaire dynamique `{ nom: { path absolu, description, url, deploy } }` :

```json
{
  "open-decks": { "path": "C:\\Users\\Gusta\\Documents\\Data\\open-decks", "url": "http://localhost:3000" }
}
```

- Rechargement à chaud : `POST /api/projects/reload` (ou `watch` auto du fichier).
- Ajout dynamique : `POST /api/projects { name, path, description?, url? }`.
- Existence du dossier vérifiée (`exists`) dans `GET /api/projects`.

## 2. Authentification (tokens / clés d'invitation)

- `GATEWAY_TOKENS` dans `.env` (séparés par virgule) + optionnel `config/tokens.json`.
- REST : `Authorization: Bearer <token>` ou `x-access-token` ou `?token=`.
- WS : `/ws?token=<token>`.
- Générer une clé : `npm run gen-token`.

## 3. Exécution sécurisée (OpenCode CLI Sandbox)

`POST /api/agent/run { project, instruction, user }` ou message WS `{ type:'run', ... }` :

1. **Snapshot** : `git add -A` + `git commit -am "Pre-agent snapshot by [User]"` dans le `cwd` cible.
2. **Context lock** : prompt système injecté —
   `Tu es un agent de développement limité STRICTEMENT au répertoire [PROJECT_PATH]... Projet cible : [PROJECT_NAME].`
3. **Exécution** : `opencode run "<prompt>"` avec `cwd = PROJECT_PATH` (`OPENCODE_BIN`, timeout `AGENT_TIMEOUT_MS`).
   Sans CLI : **SIMULATION documentée** (logs `[sim]`, aucune modification) pour valider le pipeline.
4. **Streaming** : `stdout/stderr` → WS `{ type:'log' }` + `{ type:'status' }` + `{ type:'done' }`.
5. Motifs destructeurs système bloqués pré-exécution (`scanInstruction`).

## 4. Déploiement & rollback

- Auto après agent OK : `npm run build` (si script présent) `&& pm2 restart <projet>` (si configuré et pm2 installé) → événement WS `{ type:'deployed', ok, url }`.
- Manuel : `POST /api/deploy { project }`.
- Rollback : `POST /api/agent/rollback { project }` → `git reset --hard` (+ bouton UI avec confirmation).

## 5. Exposition Ngrok

Express est configuré `trust proxy + CORS *` (équivalent `allowedHosts: true`) :

```bat
scripts\expose-ngrok.bat
```

- Prérequis : le domaine statique du compte doit être libre.
  Le `https://tricolor-approve-unscented.ngrok-free.dev` sert désormais la
  **gateway** (`/api/health` → `service: orkestr-gateway`).
  Pour cela, le tunnel auto d'open-decks a été coupé : ligne `NGROK_AUTHTOKEN`
  commentée (`#DESACTIVE-PAR-GATEWAY`) dans `open-decks/.env`, serveur
  open-decks relancé sous pm2 (local `:3000` intact, site Orkestr cloud intact).
  Restaurer : décommentez la ligne dans `open-decks/.env` puis
  `pm2.cmd restart open-decks` (cela reprendra le domaine — la gateway
  retombera en `ERR_NGROK_334` : un seul tunnel ngrok gratuit à la fois).
- Relancer le tunnel gateway : double-clic `scripts\expose-ngrok.bat`
  (ou `ngrok http 4000`).
- Ne jamais utiliser `--pooling-enabled` avec l'URL d'un autre service
  (mélange des trafics).
- Les collaborateurs ajoutent le header `ngrok-skip-browser-warning: true`
  (sinon page d'avertissement `ERR_NGROK_6024`).

## Runtime local retenu (plan Orkestr gratuit saturé : 1 projet = open-decks live)

```bat
pm2.cmd start ecosystem.config.js
pm2.cmd save
pm2.cmd list
```

- Relance auto en cas de crash (pm2). Après un reboot : `pm2.cmd resurrect`.
- UI : http://localhost:4000 · santé : `GET /api/health` · WS : `/ws?token=…`.

## Prod (pm2)

```bat
cmd /c "npm i -g pm2"
cmd /c "pm2 start ecosystem.config.js"
cmd /c "pm2 save"
```

## Déploiement sur Orkestr gratuit (comme open-decks / dice-game)

Un seul conteneur (API + UI statique sur un `PORT`), aucune dépendance externe.
`PORT` est injecté par Orkestr, healthcheck path : `/health`.

```bat
docker build -t orkestr-gateway .
docker run -p 4000:4000 -e GATEWAY_TOKENS=<token> orkestr-gateway
```

1. Pushe ce dossier sur GitHub (`gustavopertuzati/agent-hub`).
2. Dans la console Orkestr : nouveau service depuis le repo, Dockerfile à la racine.
3. Variables d'environnement :
   - `GATEWAY_TOKENS=<clé d'invitation longue et aléatoire>` (`npm run gen-token`)
   - `PROJECTS_JSON={"mon-projet":{"path":"/app","description":"...","url":"https://..."}}`
     (registre inline — les chemins Windows locaux n'existent pas dans le conteneur ;
     `POST /api/projects` est verrouillé dans ce mode)
   - `PORT` est injecté par Orkestr.
4. Healthcheck path : `/health`.
5. URL publique : `https://<service>.orkestr.run` — les collaborateurs s'y connectent
   avec `?token=<clé>` (REST + WS `/ws`).
