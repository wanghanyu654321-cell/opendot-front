FROM node:22.14.0-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY container/agent-runner/package.json container/agent-runner/package-lock.json ./container/agent-runner/
RUN npm --prefix container/agent-runner ci

COPY packages/front-claw/package.json packages/front-claw/package-lock.json ./packages/front-claw/
RUN npm --prefix packages/front-claw ci

COPY tsconfig.json tsconfig.personal-agent.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
COPY container/agent-runner ./container/agent-runner
COPY packages/front-claw ./packages/front-claw
COPY config ./config
COPY assets ./assets

RUN npm run build \
    && npm run build:web \
    && npm --prefix container/agent-runner run build \
    && npm --prefix packages/front-claw run build \
    && npm prune --omit=dev \
    && npm --prefix container/agent-runner prune --omit=dev \
    && npm --prefix packages/front-claw prune --omit=dev

FROM node:22.14.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/config ./config
COPY --from=build /app/assets ./assets
COPY --from=build /app/container/agent-runner/package.json ./container/agent-runner/package.json
COPY --from=build /app/container/agent-runner/node_modules ./container/agent-runner/node_modules
COPY --from=build /app/container/agent-runner/dist ./container/agent-runner/dist
COPY --from=build /app/container/agent-runner/prompts ./container/agent-runner/prompts
COPY --from=build /app/packages/front-claw/package.json ./packages/front-claw/package.json
COPY --from=build /app/packages/front-claw/node_modules ./packages/front-claw/node_modules
COPY --from=build /app/packages/front-claw/dist ./packages/front-claw/dist
COPY --from=build /app/packages/front-claw/config ./packages/front-claw/config
COPY --from=build /app/packages/front-claw/migrations ./packages/front-claw/migrations

RUN mkdir -p /app/data/home /app/data/db /app/data/groups \
    && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "dist/index.js"]
