# ⚠ Node 22 LTS намеренно: в node:25+ из официальных образов убран corepack
# (`RUN corepack enable` → exit 127), а версия pnpm закреплена в packageManager.
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# ⚠ Не root: контейнер смотрит в интернет через reverse-proxy и принимает POST от кого угодно.
USER node
COPY --from=builder --chown=node:node /app/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
