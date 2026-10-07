FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine
# docker-cli-buildx is load-bearing: without the buildx plugin, Compose v5
# warns "requires buildx plugin" and falls back to the legacy builder,
# which cannot reuse the BuildKit layer cache. Builds that were fully
# cached then rebuild from scratch and can exceed the 300 s runExec step
# timeout.
# tini is PID 1 so orphaned grandchildren of git/docker/sh steps (reparented
# to PID 1 when their parent is killed or exits first) are reaped. Node as
# PID 1 only reaps children it spawned itself, so without an init those
# orphans stay defunct until the container restarts. -s makes tini a
# subreaper, so it also works when it is not PID 1 (for example under
# `docker run --init` or compose `init: true`).
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose docker-cli-buildx tini
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/
EXPOSE 8222
ENTRYPOINT ["/sbin/tini", "-s", "--"]
CMD ["node", "dist/index.js"]
