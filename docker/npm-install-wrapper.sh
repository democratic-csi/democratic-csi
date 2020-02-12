#!/bin/bash

set -e
set -x

PLATFORM=$TARGETPLATFORM

if [[ "x${PLATFORM}" == "x" ]]; then
  PLATFORM="linux/amd64"
fi

if [ "$PLATFORM" = "linux/amd64" ]; then
  export NODE_ARCH="x64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export NODE_ARCH="arm64"
elif [ "$PLATFORM" = "linux/arm/v7" ]; then
  export NODE_ARCH="armv7l"
else
  echo "unsupported/unknown PLATFORM ${PLATFORM}"
  exit 1
fi

npm install --target_arch="${NODE_ARCH}"
