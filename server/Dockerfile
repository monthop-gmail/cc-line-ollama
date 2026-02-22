FROM node:22-slim

# Install system deps + git (needed by claude code)
RUN apt-get update && apt-get install -y curl unzip git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install bun globally
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# SDK bundles Claude Code CLI — no need: npm install -g @anthropic-ai/claude-code

# Create non-root user (required for bypassPermissions mode)
RUN useradd -m -s /bin/bash claude

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY src/ src/

RUN chown -R claude:claude /app /home/claude

USER claude

EXPOSE 4096

CMD ["bun", "run", "src/index.ts"]
