#!/bin/bash

set -e
set -x

PLATFORM_TYPE=${1}

if [[ "${PLATFORM_TYPE}" == "build" ]]; then
  PLATFORM=$BUILDPLATFORM
else
  PLATFORM=$TARGETPLATFORM
fi

if [[ "x${PLATFORM}" == "x" ]]; then
  PLATFORM="linux/amd64"
fi

# these come from the --platform option of buildx, indirectly from DOCKER_BUILD_PLATFORM in main.yaml
if [ "$PLATFORM" = "linux/amd64" ]; then
  export PLATFORM_ARCH="amd64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export PLATFORM_ARCH="arm64"
elif [ "$PLATFORM" = "linux/arm/v7" ]; then
  export PLATFORM_ARCH="armhv"
else
  echo "unsupported/unknown kopia PLATFORM ${PLATFORM}"
  exit 0
fi

echo "I am installing kopia $KOPIA_VERSION"

export DEB_FILE="kopia.deb"
wget -O "${DEB_FILE}" "https://github.com/kopia/kopia/releases/download/v${KOPIA_VERSION}/kopia_${KOPIA_VERSION}_linux_${PLATFORM_ARCH}.deb"
dpkg -i "${DEB_FILE}"

rm "${DEB_FILE}"
