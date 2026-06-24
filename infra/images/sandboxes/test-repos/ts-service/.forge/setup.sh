#!/usr/bin/env sh
# Setup script for the TS test repo (docs/16 §2 fixture). Runs during image build.
set -eu
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
echo "ts-service setup complete"
