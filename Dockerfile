FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine
# docker-cli-buildx is load-bearing: without the buildx plugin, Compose v5
# warns "requires buildx plugin" and silently falls back to the legacy
# builder, which ignores the BuildKit layer cache. Every app build then
# runs from scratch and can exceed the 300 s runExec step timeout
# (agent-tasks deploy 2026-09-01).
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose docker-cli-buildx
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/
EXPOSE 8222
CMD ["node", "dist/index.js"]
