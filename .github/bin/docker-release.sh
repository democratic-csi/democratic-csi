#!/bin/bash

echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin

export DOCKER_ORG="democraticcsi"
export DOCKER_PROJECT="democratic-csi"
export DOCKER_REPO="${DOCKER_ORG}/${DOCKER_PROJECT}"

if [[ $GITHUB_REF == refs/tags/* ]]; then
  export GIT_TAG=${GITHUB_REF#refs/tags/}
else
  export GIT_BRANCH=${GITHUB_REF#refs/heads/}
fi

if [[ -n "${GIT_TAG}" ]]; then
  docker buildx build --progress plain --pull --push --platform "${DOCKER_BUILD_PLATFORM}" -t ${DOCKER_REPO}:${GIT_TAG} .
elif [[ -n "${GIT_BRANCH}" ]]; then
  if [[ "${GIT_BRANCH}" == "master" ]]; then
    docker buildx build --progress plain --pull --push --platform "${DOCKER_BUILD_PLATFORM}" -t ${DOCKER_REPO}:latest .
  else
    docker buildx build --progress plain --pull --push --platform "${DOCKER_BUILD_PLATFORM}" -t ${DOCKER_REPO}:${GIT_BRANCH} .
  fi
else
  :
fi
