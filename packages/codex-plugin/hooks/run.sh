#!/bin/sh
# Runs one of this plugin's Node entry points, and does nothing at all if Node cannot be found.
#
# Codex does not hand a hook the PATH of the session that started it: it rebuilds one from a
# shell snapshot, which on a machine whose Node comes from a version manager loaded in an
# interactive rc file does not contain `node`. A bare `node` there exits 127, and Codex paints
# "Hook failed" in the scrollback at every single turn. An adviser must never do that, so a
# missing Node is a silent no-op instead: no advice, no noise, no failed turn.
#
# COMPACT_ADVISER_NODE overrides the search with an absolute path to a Node binary.
set -u

entry=$1

find_node() {
  if [ -n "${COMPACT_ADVISER_NODE:-}" ] && [ -x "${COMPACT_ADVISER_NODE}" ]; then
    printf '%s' "${COMPACT_ADVISER_NODE}"
    return 0
  fi
  if resolved=$(command -v node 2>/dev/null); then
    printf '%s' "${resolved}"
    return 0
  fi
  # The usual places a version manager or package manager puts it, newest nvm release first.
  for candidate in \
    "${HOME:-}"/.volta/bin/node \
    "${HOME:-}"/.local/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    [ -x "${candidate}" ] && printf '%s' "${candidate}" && return 0
  done
  for candidate in $(ls -d "${HOME:-}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV); do
    [ -x "${candidate}" ] && printf '%s' "${candidate}" && return 0
  done
  return 1
}

node_binary=$(find_node) || {
  # An empty object is the "nothing to say" answer for every event this plugin registers.
  printf '{}'
  exit 0
}

exec "${node_binary}" "${entry}"
