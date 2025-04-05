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
  export PLATFORM_ARCH="arm"
elif [ "$PLATFORM" = "linux/s390x" ]; then
  export PLATFORM_ARCH="s390x"
elif [ "$PLATFORM" = "linux/ppc64le" ]; then
  export PLATFORM_ARCH="ppc64le"
else
  echo "unsupported/unknown yq PLATFORM ${PLATFORM}"
  exit 0
fi

echo "I am installing yq $YQ_VERSION"

wget https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${PLATFORM_ARCH} -O /usr/local/bin/yq
chmod +x /usr/local/bin/yq

