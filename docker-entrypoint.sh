#!/bin/bash
# entrypoint for the pullfrog GHA-like container (see Dockerfile).
#
# - remaps `testuser` to the host uid/gid so bind-mounted files keep correct
#   ownership after writes inside the container
# - on linux hosts, copies host ssh keys into testuser's $HOME (darwin hosts
#   forward the ssh-agent socket instead, no copy needed)
# - installs action workspace deps (volume-cached, ~1.5s warm)
# - exec's the requested command as testuser; argv is preserved (no nested
#   `bash -c`, no shell quoting hazards)
set -euo pipefail

HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"

if [ "$HOST_UID" != "1000" ] || [ "$HOST_GID" != "1000" ]; then
    groupmod -g "$HOST_GID" testuser 2>/dev/null || true
    usermod -u "$HOST_UID" -g "$HOST_GID" testuser 2>/dev/null || true
    # chown top-level dirs only — recursive chown would fail on `:ro` bind
    # mounts (e.g. macOS known_hosts mounted directly into /tmp/home/.ssh).
    chown "$HOST_UID:$HOST_GID" /tmp/home /tmp/home/.config /tmp/home/.cache 2>/dev/null || true
    chown "$HOST_UID:$HOST_GID" /app /app/action /app/action/node_modules 2>/dev/null || true
fi

# linux hosts: copy host ssh keys into testuser's $HOME (we own this dir,
# safe to chown). darwin hosts forward the ssh-agent socket instead and
# bind-mount known_hosts read-only — nothing to do here.
if [ -d /tmp/.ssh-host ]; then
    mkdir -p /tmp/home/.ssh
    cp /tmp/.ssh-host/id_* /tmp/home/.ssh/ 2>/dev/null || true
    chmod 600 /tmp/home/.ssh/id_* 2>/dev/null || true
    ssh-keyscan -t ed25519,rsa github.com >> /tmp/home/.ssh/known_hosts 2>/dev/null || true
    chmod 644 /tmp/home/.ssh/known_hosts 2>/dev/null || true
    chown -R "$HOST_UID:$HOST_GID" /tmp/home/.ssh 2>/dev/null || true
    # set GIT_SSH_COMMAND if any private key got copied. don't pin a
    # specific key with -i — let ssh pick whatever's in /tmp/home/.ssh
    # (covers id_rsa, id_ed25519, id_ecdsa, etc.).
    if ls /tmp/home/.ssh/id_* 2>/dev/null | grep -qv '\.pub$'; then
        export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/tmp/home/.ssh/known_hosts -o StrictHostKeyChecking=no"
    fi
fi

# warm the volume-cached node_modules. frozen-lockfile + ignore-scripts keeps
# this idempotent and fast (~1.5s when nothing changed).
#
# the lockfile lives IN the shared node_modules volume so concurrent
# `pnpm docker` invocations (e.g. `pnpm play:docker` in one terminal and
# `pnpm runtest:docker` in another) serialize their install instead of racing.
# `flock -w 120` waits up to 2min before giving up — well under any
# real-world install time but short enough to surface true deadlocks.
mkdir -p /app/action/node_modules
flock -w 120 /app/action/node_modules/.gha-install.lock \
    sudo -u testuser -E env HOME=/tmp/home \
        corepack pnpm install --frozen-lockfile --ignore-scripts >/dev/null

# `--shell` drops into an interactive bash for debugging the container.
if [ "${1:-}" = "--shell" ]; then
    exec sudo -u testuser -E env HOME=/tmp/home bash
fi

# exec the command as testuser, preserving env. argv passes through unchanged
# — no `bash -c` nesting, no quoting required by callers.
exec sudo -u testuser -E env HOME=/tmp/home "$@"
