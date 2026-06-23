# pullfrog GHA-like test container.
#
# baked once at image build time, used by `pnpm docker`. all runtime cost
# (apt-get, useradd, sudoers wiring) is paid here so each `docker` invocation
# is a single `docker run` with no in-container setup.
#
# rebuild is content-hash gated by docker.ts (Dockerfile + docker-entrypoint.sh).
# bump anything in this file or the entrypoint and the next `pnpm docker` rebuilds.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# core toolset matching what GHA `ubuntu-24.04` runners ship: gh, jq, git,
# python3, ssh client, plus the compression + build-essential surface that
# `pnpm install` / `node-gyp` / agent shell calls regularly need. keeps
# test-time invocations of these tools honest (no "works on the runner,
# breaks in the local container").
RUN apt-get update -qq \
    && apt-get install -qq -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        file \
        git \
        gnupg \
        jq \
        openssh-client \
        python3 \
        sudo \
        unzip \
        wget \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# node 24 from nodesource + corepack (corepack still provisions the customer's
# declared pnpm/yarn at runtime — see action/utils/packageManager.ts). nub is
# the repo's own toolchain (`nub run`, `nub ci`, native .ts execution).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && npm install -g --ignore-scripts=false @nubjs/nub

# gh cli (matches GHA pre-installed tooling).
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq \
    && apt-get install -qq -y gh \
    && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships a default `ubuntu` user at uid 1000 — remove it so we
# can place `testuser` at 1000 (the typical macOS dev uid). the entrypoint
# remaps to the host uid/gid at runtime if they differ.
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -g 1000 testuser \
    && useradd -u 1000 -g 1000 -m -s /bin/bash testuser \
    && echo "testuser ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/testuser \
    && chmod 0440 /etc/sudoers.d/testuser

# layout matching the bind mount + named volume targets in docker.ts.
RUN mkdir -p /app/action /app/action/node_modules /tmp/home/.config /tmp/home/.cache \
    && chown -R testuser:testuser /app /tmp/home

# CI=true is critical: `shell.ts` PID-namespace sandbox keys off it. baking
# it ensures security tests can't pass vacuously because someone forgot the
# flag.
ENV HOME=/tmp/home \
    TMPDIR=/tmp \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app/action
ENTRYPOINT ["/entrypoint.sh"]
