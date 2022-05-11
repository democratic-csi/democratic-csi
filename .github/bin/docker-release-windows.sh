#!/bin/bash

set -e

echo "$DOCKER_PASSWORD" | docker login docker.io -u "$DOCKER_USERNAME" --password-stdin
echo "$GHCR_PASSWORD"   | docker login ghcr.io   -u "$GHCR_USERNAME"   --password-stdin

export DOCKER_ORG="democraticcsi"
export DOCKER_PROJECT="democratic-csi"
export DOCKER_REPO="docker.io/${DOCKER_ORG}/${DOCKER_PROJECT}"

export GHCR_ORG="democratic-csi"
export GHCR_PROJECT="democratic-csi"
export GHCR_REPO="ghcr.io/${GHCR_ORG}/${GHCR_PROJECT}"

export MANIFEST_NAME="democratic-csi-combined:${IMAGE_TAG}"

if [[ -n "${IMAGE_TAG}" ]]; then
  # create local manifest to work with
  buildah manifest rm "${MANIFEST_NAME}" || true
  buildah manifest create "${MANIFEST_NAME}"
  
  # all all the existing linux data to the manifest
  buildah manifest add "${MANIFEST_NAME}" --all "${DOCKER_REPO}:${IMAGE_TAG}"
  buildah manifest inspect "${MANIFEST_NAME}"
  
  # import pre-built images
  buildah pull docker-archive:democratic-csi-windows-ltsc2019.tar
  buildah pull docker-archive:democratic-csi-windows-ltsc2022.tar

  # add pre-built images to manifest
  buildah manifest add "${MANIFEST_NAME}" democratic-csi-windows:${GITHUB_RUN_ID}-ltsc2019
  buildah manifest add "${MANIFEST_NAME}" democratic-csi-windows:${GITHUB_RUN_ID}-ltsc2022
  buildah manifest inspect "${MANIFEST_NAME}"

  # push manifest
  buildah manifest push --all "${MANIFEST_NAME}" docker://${DOCKER_REPO}:${IMAGE_TAG}
  buildah manifest push --all "${MANIFEST_NAME}" docker://${GHCR_REPO}:${IMAGE_TAG}

  # cleanup
  buildah manifest rm "${MANIFEST_NAME}" || true
else
  :
fi