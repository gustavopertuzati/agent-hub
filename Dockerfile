# Single container: Express Gateway + static UI on one PORT.
# Same deploy shape as open-decks / dice-game: PORT injected by the host (orkestr),
# /health healthcheck, no external dependency.
# Registry: local config/projects.json, or inline via env PROJECTS_JSON on Orkestr.
FROM node:20-slim
ENV NODE_ENV=production \
    PORT=4000 \
    TZ=Europe/Zurich
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
COPY config/ ./config/
COPY scripts/ ./scripts/
RUN chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
