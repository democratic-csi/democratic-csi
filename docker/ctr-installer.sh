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
	echo "unsupported/unknown ctr PLATFORM ${PLATFORM}"
	exit 0
fi

echo "I am installing ctr $CTR_VERSION"

export CTR_FILE="ctr-${CTR_VERSION}-linux-${PLATFORM_ARCH}"
wget -O "${CTR_FILE}" "https://github.com/democratic-csi/democratic-csi/releases/download/v1.0.0/${CTR_FILE}"

mv ${CTR_FILE} /usr/local/bin/ctr
chown root:root /usr/local/bin/ctr
chmod +x /usr/local/bin/ctr
