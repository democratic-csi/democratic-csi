#!/bin/bash

set -e
set -x

export PATH="/usr/local/lib/nodejs/bin:${PATH}"
echo "current launch-server PATH: ${PATH}"

: ${CI_BUILD_KEY:="local"}
: ${TEMPLATE_CONFIG_FILE:=${1}}
: ${CSI_MODE:=""}
: ${CSI_VERSION:="1.5.0"}
: ${CSI_ENDPOINT:=/tmp/csi-${CI_BUILD_KEY}.sock}
: ${LOG_PATH:=/tmp/csi-${CI_BUILD_KEY}.log}

if [[ "x${CONFIG_FILE}" == "x" ]];then
  : ${CONFIG_FILE:=/tmp/csi-config-${CI_BUILD_KEY}.yaml}

  if [[ "x${TEMPLATE_CONFIG_FILE}" != "x" ]];then
    envsubst < "${TEMPLATE_CONFIG_FILE}" > "${CONFIG_FILE}"
  fi
fi

if [[ "x${CSI_MODE}" != "x" ]];then
  EXTRA_ARGS="--csi-mode ${CSI_MODE} ${EXTRA_ARGS}"
fi

# > "${LOG_PATH}" 2>&1 
exec ./bin/democratic-csi --log-level debug --driver-config-file "${CONFIG_FILE}" --csi-version "${CSI_VERSION}" --csi-name "driver-test" --server-socket "${CSI_ENDPOINT}" ${EXTRA_ARGS}
