#!/bin/bash

set -e
set -x

ROOT_DIR="$(dirname "$(realpath "$0")")"

GITHUB_USER=${GITHUB_USER:-$(jq -r '.auths."ghcr.io".auth' ~/.docker/config.json|base64 -d|cut -d':' -f1)}
GITHUB_REPO=${GITHUB_REPO:-$(basename -s ${ROOT_DIR}/../.git $(git remote get-url origin))}
DOCKER_TAG=${DOCKER_TAG:-$(git branch --show-current)-$(git rev-parse --short HEAD)}

if [ -z "${GITHUB_USER}" ]; then
  echo "Error: Need to login to ghcr.io ; execute docker login ghcr.io"
  exit 1
fi

docker build $ROOT_DIR/.. --push -t ghcr.io/${GITHUB_USER}/${GITHUB_REPO}:${DOCKER_TAG}
echo "Image pushed to ghcr.io/${GITHUB_USER}/${GITHUB_REPO}:${DOCKER_TAG}"