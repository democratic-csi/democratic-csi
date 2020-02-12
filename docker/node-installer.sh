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

if [ "$PLATFORM" = "linux/amd64" ]; then
  export NODE_DISTRO="linux-x64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export NODE_DISTRO="linux-arm64"
elif [ "$PLATFORM" = "linux/arm/v7" ]; then
  export NODE_DISTRO="linux-armv7l"
else
  echo "unsupported/unknown PLATFORM ${PLATFORM}"
  exit 1
fi

echo "I am installing node $NODE_VERSION $NODE_DISTRO"

wget https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz >/dev/null 2>&1
mkdir -p /usr/local/lib/nodejs
tar -xJf node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz -C /usr/local/lib/nodejs --strip-components=1
rm node-${NODE_VERSION}-${NODE_DISTRO}.tar.xz
rm -rf /var/lib/apt/lists/*
