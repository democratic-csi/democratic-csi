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
  export NODE_DISTRO="linux-x64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export NODE_DISTRO="linux-arm64"
elif [ "$PLATFORM" = "linux/arm/v7" ]; then
  export NODE_DISTRO="linux-armv7l"
elif [ "$PLATFORM" = "linux/s390x" ]; then
  export NODE_DISTRO="linux-s390x"
elif [ "$PLATFORM" = "linux/ppc64le" ]; then
  export NODE_DISTRO="linux-ppc64le"
else
  echo "unsupported/unknown PLATFORM ${PLATFORM}"
  exit 1
fi

echo "I am installing node $NODE_VERSION $NODE_DISTRO"

if [[ "x${NODE_TARGET_DIR}" == "x" ]]; then
  NODE_TARGET_DIR="/usr/local/lib/nodejs"
fi

wget https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz >/dev/null 2>&1
mkdir -p ${NODE_TARGET_DIR}
tar -xJf node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz -C ${NODE_TARGET_DIR} --strip-components=1
rm node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz
