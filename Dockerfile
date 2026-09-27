# Multi-stage build — keeps the final image to just what's needed to run
# (compiled JS + node_modules + the generated Prisma client), not the full
# TypeScript source, dev dependencies, or build toolchain.
FROM node:22-slim AS base
WORKDIR /app
# ca-certificates: needed for HTTPS calls to LiveKit, Deepgram, Groq, and
# the Postgres connection (Neon requires TLS) to actually verify certs.
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
# Includes devDependencies deliberately (no --omit=dev here) — the build
# stage below needs typescript, prisma, and @types/* to compile at all.
# The runner stage further down only copies the compiled output and
# node_modules from THIS layer, so devDependencies never end up bloating
# the final image; this layer is just a build-time intermediate.
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

CMD ["node", "dist/agent.js", "start"]
