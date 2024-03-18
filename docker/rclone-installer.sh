#!/bin/bash

set -e
set -x

PLATFORM_TYPE=${1}

if [[ "${PLATFORM_TYPE}" == "build" ]]; then
  PLATFORM=$BUILDPLATFORM
else
  PLATFORM=$TARGETPLATFORM
fi

# linux/amd64,linux/arm64,linux/arm/v7,linux/s390x,linux/ppc64le
if [[ "x${PLATFORM}" == "x" ]]; then
  PLATFORM="linux/amd64"
fi

# these come from the --platform option of buildx, indirectly from DOCKER_BUILD_PLATFORM in main.yaml
# linux/amd64,linux/arm64,linux/arm/v7,linux/s390x,linux/ppc64le
if [ "$PLATFORM" = "linux/amd64" ]; then
  export PLATFORM_ARCH="amd64"
elif [ "$PLATFORM" = "linux/arm64" ]; then
  export PLATFORM_ARCH="arm"
elif [ "$PLATFORM" = "linux/arm/v7" ]; then
  export PLATFORM_ARCH="arm-v7"
else
  echo "unsupported/unknown restic PLATFORM ${PLATFORM}"
  exit 0
fi

echo "I am installing rclone $RCLONE_VERSION"

export ZIP_FILE="rclone.zip"
wget -O "${ZIP_FILE}" "https://github.com/rclone/rclone/releases/download/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${PLATFORM_ARCH}.zip"
unzip "${ZIP_FILE}"

mv rclone-*-linux-*/rclone /usr/local/bin/rclone
rm -rf rclone-*-linux-*
chown root:root /usr/local/bin/rclone
chmod +x /usr/local/bin/rclone
