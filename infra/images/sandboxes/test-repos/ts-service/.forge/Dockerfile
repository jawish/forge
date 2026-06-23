# TypeScript test repo Dockerfile (docs/16 §2 fixture). Chainguard-derived base.
FROM chainguard/node:22

WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod
COPY . .
RUN pnpm build

CMD ["node", "dist/main.js"]
