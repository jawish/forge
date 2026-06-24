# TypeScript test repo Dockerfile (docs/16 §2 fixture). Chainguard-derived base.
# Uses the -dev variant so the agent harness + setup.sh have a shell at runtime
# (the distroless node image has no /bin/sh). See the python-service Dockerfile
# for the rationale. Note: Chainguard publishes node:latest-dev, not node:22-dev.
FROM chainguard/node:latest-dev
# The base image sets ENTRYPOINT ["node"], which would prepend the CMD below.
# Sandboxes need a plain shell entrypoint so the agent harness can exec arbitrary
# commands — reset it.
ENTRYPOINT []

WORKDIR /workspace
COPY package.json ./
# pnpm is already on PATH in the Chainguard node image (no corepack enable
# needed — that fails with EACCES since the image is non-root). Install ALL
# deps (no --prod) because `tsc` is a devDependency. No committed lockfile in
# this fixture (single private test image), so don't require one. Real repos
# ship pnpm-lock.yaml and use --frozen-lockfile.
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build

CMD ["node", "dist/main.js"]
