# Python test repo Dockerfile (docs/16 §2 fixture). Chainguard-derived base (docs/08 §15).
# Real per-repo images are built + cosign-signed + pushed to GHCR (§7.2 spike);
# this is the test fixture for the build pipeline + repo-config validation.
#
# Uses the -dev variant because sandboxes are interactive: the agent harness
# (OpenCode) + setup.sh need a shell at runtime. The non-dev (distroless) image
# has no /bin/sh, so RUN steps and command execution fail. The -dev image still
# runs as non-root and is scanned+signed before spawn (ADR-0007).
FROM chainguard/python:latest-dev
# The base image sets ENTRYPOINT ["/usr/bin/python"], which would prepend the
# CMD below ("python ...") and double it. Sandboxes need a plain shell entrypoint
# so the agent harness can exec arbitrary commands — reset it.
ENTRYPOINT []

WORKDIR /workspace
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# The agent harness (OpenCode) is started by the control plane at spawn, not here.
CMD ["python", "-m", "app.main"]
