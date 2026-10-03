# Jovi Core v0.1 — API image
# Base images are pinned by digest (R-07): node:22-bookworm-slim (Node 22.23.3, resolved 2026-10-03).
# Dependabot (docker ecosystem) proposes digest updates.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
# Toolchain for better-sqlite3 in case no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=data/jovi.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Runtime assets resolved from the project root.
COPY prompts ./prompts
COPY knowledge ./knowledge
COPY src/database/migrations ./src/database/migrations
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/apps/api/main.js"]
