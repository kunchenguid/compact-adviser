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
    "${HOME:-}"/.local/bin/node; do
    [ -x "${candidate}" ] && printf '%s' "${candidate}" && return 0
  done
  newest=
  newest_major=-1
  newest_minor=-1
  newest_patch=-1
  for candidate in "${HOME:-}/.nvm/versions/node/"*/bin/node; do
    [ -x "${candidate}" ] || continue
    version=${candidate%/bin/node}
    version=${version##*/}
    version=${version#v}
    major=${version%%.*}
    rest=${version#*.}
    if [ "${rest}" = "${version}" ]; then
      minor=0
      patch=0
    else
      minor=${rest%%.*}
      rest=${rest#*.}
      if [ "${rest}" = "${minor}" ]; then
        patch=0
      else
        patch=${rest%%.*}
      fi
    fi
    case ${major} in *[!0-9]* | "") continue ;; esac
    case ${minor} in *[!0-9]* | "") minor=0 ;; esac
    case ${patch} in *[!0-9]* | "") patch=0 ;; esac
    if [ "${major}" -gt "${newest_major}" ] ||
      { [ "${major}" -eq "${newest_major}" ] && [ "${minor}" -gt "${newest_minor}" ]; } ||
      { [ "${major}" -eq "${newest_major}" ] && [ "${minor}" -eq "${newest_minor}" ] && [ "${patch}" -gt "${newest_patch}" ]; }; then
      newest=${candidate}
      newest_major=${major}
      newest_minor=${minor}
      newest_patch=${patch}
    fi
  done
  if [ -n "${newest}" ]; then
    printf '%s' "${newest}"
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
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
