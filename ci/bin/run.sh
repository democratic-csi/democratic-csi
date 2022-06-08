#!/bin/bash

set -e
set -x

_term() {
  # no idea why this does not work
  #[[ -n "${SUDO_PID}" ]] && sudo kill -15 "${SUDO_PID}"
  [[ -n "${SUDO_PID}" ]] && sudo kill -15 $(pgrep -P "${SUDO_PID}") || true
}

trap _term EXIT

export PATH="/usr/local/lib/nodejs/bin:${PATH}"
# install deps
#npm i
# install from artifacts
if [[ -f "node_modules-linux-amd64.tar.gz" && ! -d "node_modules" ]];then
  tar -zxf node_modules-linux-amd64.tar.gz
fi

# generate key for paths etc
export CI_BUILD_KEY=$(uuidgen | cut -d "-" -f 1)

# launch the server
sudo -E ci/bin/launch-server.sh &
SUDO_PID=$!

# wait for server to launch
#sleep 10

: ${CSI_ENDPOINT:=/tmp/csi-${CI_BUILD_KEY}.sock}
iter=0
max_iter=60
while [ ! -S "${CSI_ENDPOINT}" ];do
  ((++iter))
  echo "waiting for ${CSI_ENDPOINT} to appear"
  sleep 1
  if [[ $iter -gt $max_iter ]];then
    echo "${CSI_ENDPOINT} failed to appear"
    exit 1
  fi
done

# launch csi-sanity
sudo -E ci/bin/launch-csi-sanity.sh
