# Single image for api / engine / web — compose picks the command per service.
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# install deps with good layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/engine/package.json apps/engine/package.json
COPY apps/research/package.json apps/research/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/evidence/package.json packages/evidence/package.json
COPY packages/experiments/package.json packages/experiments/package.json
COPY packages/polymarket/package.json packages/polymarket/package.json
COPY packages/risk/package.json packages/risk/package.json
COPY packages/strategy/package.json packages/strategy/package.json
RUN pnpm install --frozen-lockfile

COPY . .

# production Next.js build (api/engine run TS via tsx and need no build).
# API_PROXY_TARGET must be supplied at BUILD time: Next.js evaluates
# rewrites() once during `next build` and freezes the destination into the
# routes manifest — a runtime env var on the built image has no effect.
ARG API_PROXY_TARGET=http://127.0.0.1:8787
ENV API_PROXY_TARGET=${API_PROXY_TARGET}
RUN pnpm --filter @b5p/web build

EXPOSE 3000 8787
# default command overridden per compose service
CMD ["pnpm", "--filter", "@b5p/api", "start"]
