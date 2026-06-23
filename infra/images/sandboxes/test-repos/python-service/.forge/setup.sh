#!/usr/bin/env sh
# Setup script for the Python test repo (docs/16 §2 fixture). Runs during image
# build to install deps + init caches. Real per-repo scripts vary; this is the
# minimal test fixture.
set -eu

pip install --no-cache-dir -r requirements.txt
echo "python-service setup complete"
