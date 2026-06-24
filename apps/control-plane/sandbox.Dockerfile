# Forge sandbox base image — the container the CF Sandbox SDK boots for each agent
# session (docs/08 §3, docs/16 §2). Ubuntu with Node, Python, git, + OpenCode.
#
# This image is used by the CF Sandbox SDK's containers config in wrangler.jsonc.
# When getSandbox() provisions a new sandbox, it starts a container from this image.

FROM ubuntu:24.04

# Avoid interactive prompts during apt install.
ENV DEBIAN_FRONTEND=noninteractive

# Install base tools: git, curl, build tools, Python, Node.js.
RUN apt-get update && apt-get install -y \
    git curl wget unzip vim jq build-essential \
    python3 python3-pip python3-venv \
    ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 via NodeSource.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm (for repos that use it).
RUN npm install -g pnpm@10

# Install OpenCode (the agent harness that runs inside the sandbox).
# This is installed globally so `opencode run` is available in PATH.
RUN npm install -g opencode-ai

# Create the workspace directory (where repos are cloned).
RUN mkdir -p /workspace && chmod 777 /workspace

# Set up git defaults (overridden per-session by the provider).
RUN git config --global user.name "forge-agent" && \
    git config --global user.email "forge@noreply.example.com" && \
    git config --global init.defaultBranch main && \
    git config --global safe.directory '/workspace'

# Expose port 8080 (the Sandbox SDK default for tunnels + health checks).
EXPOSE 8080

WORKDIR /workspace
