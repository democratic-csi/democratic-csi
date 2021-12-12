#!/bin/bash

set -e
set -x

_term() {
  #[[ -n "${SUDO_PID}" ]] && sudo kill -15 "${SUDO_PID}"
  [[ -n "${SUDO_PID}" ]] && kill -15 "${SUDO_PID}"
}

trap _term EXIT

export PATH="/usr/local/lib/nodejs/bin:${PATH}"
# install deps
npm i

# generate key for paths etc
export CI_BUILD_KEY=$(uuidgen | cut -d "-" -f 1)

# launch the server
sudo -E ci/bin/launch-server.sh &
SUDO_PID=$!

# wait for server to launch
sleep 10

# launch csi-sanity
#sudo -E ci/bin/launch-csi-sanity.sh
