#!/usr/bin/env bash
# Verify that both Docker build stages use the same pinned multi-platform
# Node image from the official Docker Hub registry, including arm64 and amd64.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$repo_root/docker/Dockerfile"
ref="$(sed -n -E 's/^ARG NODE_IMAGE=(.*)$/\1/p' "$dockerfile")"

if [[ ! "$ref" =~ ^docker\.io/library/node:24-bookworm-slim@sha256:[a-f0-9]{64}$ ]]; then
  echo "Invalid or unpinned Docker base image reference" >&2
  exit 1
fi

if [[ "$(grep -Fc 'FROM ${NODE_IMAGE} AS ' "$dockerfile")" != "2" ]]; then
  echo "Both build and runtime stages must use the same pinned Node image" >&2
  exit 1
fi

echo "Inspecting pinned Node image manifest index (not mutable tag): $ref"
manifest="$(docker buildx imagetools inspect --raw "$ref")"

if ! jq -e '
  (.mediaType == "application/vnd.oci.image.index.v1+json" or
   .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json") and
  ([.manifests[] | select(.platform.os == "linux") | .platform.architecture] |
    (index("amd64") != null and index("arm64") != null))
' <<< "$manifest" >/dev/null; then
  echo "Pinned base image is not a manifest index containing both AMD64 and ARM64" >&2
  exit 1
fi

actual="$(docker buildx imagetools inspect "$ref" | awk '/^Digest:/ { print $2; exit }')"
expected="${ref##*@}"
if [[ "$actual" != "$expected" ]]; then
  echo "Registry resolved digest does not match the Dockerfile digest" >&2
  exit 1
fi

echo "Verified immutable manifest index $actual (linux/amd64 and linux/arm64)."
