# Forge sandbox base image — builds on the official Cloudflare Sandbox base image
# (cloudflare/sandbox) which provides the session server ENTRYPOINT + HTTP API.
# We add Node, Python, git, and OpenCode on top.
#
# The Sandbox SDK requires this base image — it sets the correct ENTRYPOINT
# (the session server binary that the Sandbox DO communicates with).
# See: https://developers.cloudflare.com/sandbox/configuration/dockerfile/

FROM cloudflare/sandbox:0.12.1

# The base image has Python, Node, and Git pre-installed.
# We add OpenCode (the agent harness) and pnpm.

# Install pnpm for repos that use it.
RUN npm install -g pnpm@10 2>/dev/null || true

# Install OpenCode (the agent harness that runs inside the sandbox).
RUN npm install -g opencode-ai 2>/dev/null || true

# Create the workspace directory (where repos are cloned).
RUN mkdir -p /workspace && chmod 777 /workspace

# Set up git defaults (overridden per-session by the provider).
RUN git config --global user.name "forge-agent" && \
    git config --global user.email "forge@noreply.example.com" && \
    git config --global init.defaultBranch main && \
    git config --global safe.directory '/workspace'

# Do NOT set CMD or ENTRYPOINT — the base image's ENTRYPOINT (the session
# server) must remain intact for the Sandbox SDK to communicate with the container.
