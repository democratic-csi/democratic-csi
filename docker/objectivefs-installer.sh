#!/bin/bash

set -e
set -x

if [[ -z "${OBJECTIVEFS_DOWNLOAD_ID}" ]]; then
  echo 'missing OBJECTIVEFS_DOWNLOAD_ID, moving on'
  exit 0
fi

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
  export OBJECTIVEFS_ARCH="amd64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export OBJECTIVEFS_ARCH="arm64"
else
  echo "unsupported/unknown PLATFORM ${PLATFORM}"
  exit 0
fi

export DEB_FILE="objectivefs_${OBJECTIVEFS_VERSION}_${OBJECTIVEFS_ARCH}.deb"

echo "I am installing objectivefs $OBJECTIVEFS_VERSION"

wget "https://objectivefs.com/user/download/${OBJECTIVEFS_DOWNLOAD_ID}/${DEB_FILE}"
dpkg -i "${DEB_FILE}"

rm "${DEB_FILE}"
