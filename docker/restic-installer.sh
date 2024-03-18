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
# linux/amd64,linux/arm64,linux/arm/v7,linux/s390x,linux/ppc64le
if [ "$PLATFORM" = "linux/amd64" ]; then
  export PLATFORM_ARCH="amd64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export PLATFORM_ARCH="arm64"
elif [ "$PLATFORM" = "linux/arm/v7" ]; then
  export PLATFORM_ARCH="arm"
elif [ "$PLATFORM" = "linux/s390x" ]; then
  export PLATFORM_ARCH="s390x"
elif [ "$PLATFORM" = "linux/ppc64le" ]; then
  export PLATFORM_ARCH="ppc64le"
else
  echo "unsupported/unknown restic PLATFORM ${PLATFORM}"
  exit 0
fi

echo "I am installing restic $RESTIC_VERSION"

export TAR_FILE="restic.bz2"
wget -O "${TAR_FILE}" "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${PLATFORM_ARCH}.bz2"
bunzip2 "${TAR_FILE}"
mv restic /usr/local/bin
chown root:root /usr/local/bin/restic
chmod +x /usr/local/bin/restic
