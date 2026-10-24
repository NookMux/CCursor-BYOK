# syntax=docker/dockerfile:1

# ── stage 1: bundle the standalone server from the vendored source ──
FROM node:24-bookworm-slim AS build

# git — bootstrap.mjs applies patches/*.patch with `git apply`
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
# root deps (esbuild for the bundler script)
RUN npm ci --no-audit --no-fund

# vendor production deps in their own layer, so source edits don't bust it.
# npm install (not npm ci): the supermarkdown platform packages are optional
# and absent from the lock's packages map — npm ci refuses on that; the main
# supermarkdown package already bundles every .node binary anyway.
COPY vendor/CCursor/Cursor++/package.json vendor/CCursor/Cursor++/package-lock.json ./vendor/CCursor/Cursor++/
RUN cd vendor/CCursor/Cursor++ && npm install --omit=dev --no-audit --no-fund

COPY vendor/ ./vendor/
COPY patches/ ./patches/
COPY src/ ./src/
# installs nothing (deps already present), applies patches/, bundles dist/server.cjs
RUN node scripts/bootstrap.mjs

# ── stage 2: minimal runtime ──
FROM node:24-bookworm-slim

# node:24-bookworm-slim ships a built-in unprivileged `node` user (uid/gid 1000)
RUN mkdir -p /home/node/.ccursor && chown -R node:node /home/node

WORKDIR /app
COPY --from=build /repo/dist/server.cjs ./server.cjs

# optional native HTML→Markdown converter for the built-in Web Fetch tool;
# every platform binary (linux amd64/arm64, gnu/musl, ...) ships inside this
# one package — missing it only disables that single tool
COPY --from=build /repo/vendor/CCursor/Cursor++/node_modules/@vakra-dev/supermarkdown ./node_modules/@vakra-dev/supermarkdown

ENV NODE_ENV=production \
    BYOK_HOST=0.0.0.0 \
    BYOK_PORT=8630

# providers.json / routes.json / cursor.db / logs all live under $HOME/.ccursor
USER node
EXPOSE 8630
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BYOK_PORT||8630)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.cjs"]
