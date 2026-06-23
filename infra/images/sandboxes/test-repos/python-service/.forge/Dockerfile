# Python test repo Dockerfile (docs/16 §2 fixture). Chainguard-derived base (docs/08 §15).
# Real per-repo images are built + cosign-signed + pushed to GHCR (§7.2 spike);
# this is the test fixture for the build pipeline + repo-config validation.
FROM chainguard/python:latest

WORKDIR /workspace
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# The agent harness (OpenCode) is started by the control plane at spawn, not here.
CMD ["python", "-m", "app.main"]
