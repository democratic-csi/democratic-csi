#!/bin/bash

set -e
set -x

: ${CI_BUILD_KEY:="local"}
: ${CSI_ENDPOINT:=/tmp/csi-${CI_BUILD_KEY}.sock}
: ${CSI_SANITY_TEMP_DIR:=$(mktemp -d -t ci-csi-sanity-tmp-XXXXXXXX)}

if [[ ! -S "${CSI_ENDPOINT}" ]]; then
  echo "csi socket: ${CSI_ENDPOINT} does not exist"
  exit 1
fi

trap ctrl_c INT

function ctrl_c() {
  echo "Trapped CTRL-C"
  exit 1
}

chmod g+w,o+w "${CSI_ENDPOINT}"
mkdir -p "${CSI_SANITY_TEMP_DIR}"
rm -rf "${CSI_SANITY_TEMP_DIR}"/*
chmod -R 777 "${CSI_SANITY_TEMP_DIR}"

# https://github.com/kubernetes-csi/csi-test/tree/master/cmd/csi-sanity
# FOR DEBUG: --ginkgo.v
# --csi.secrets=<path to secrets file>
#
# expand size 2073741824 to have mis-alignments
# expand size 2147483648 to have everything line up nicely

csi-sanity --csi.endpoint "unix://${CSI_ENDPOINT}" \
  --csi.mountdir "${CSI_SANITY_TEMP_DIR}/mnt" \
  --csi.stagingdir "${CSI_SANITY_TEMP_DIR}/stage" \
  --csi.testvolumeexpandsize 2147483648 \
  --csi.testvolumesize 1073741824 \
  --csi.secrets="${CSI_SANITY_SECRETS}" \
  -ginkgo.skip "${CSI_SANITY_SKIP}" \
  -ginkgo.focus "${CSI_SANITY_FOCUS}"

rm -rf "${CSI_SANITY_TEMP_DIR}"
