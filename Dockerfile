# syntax=docker/dockerfile:1

# ---- build: compile TypeScript with dev dependencies available ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: no compiler, no dev dependencies, non-root user ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# SQL migrations are read at runtime (dist/infrastructure/db/migrate.js resolves ../../../drizzle).
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node package.json ./
USER node
ENV PORT=3000
EXPOSE 3000
# Same image runs both processes: the default is the HTTP server; the worker overrides the command.
CMD ["node", "dist/server.js"]
