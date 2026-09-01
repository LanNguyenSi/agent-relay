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
RUN apk add --no-cache git openssh-client docker-cli docker-cli-compose docker-cli-buildx
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/
EXPOSE 8222
CMD ["node", "dist/index.js"]
