#!/bin/bash

set -e
set -x

export PATH="/usr/local/lib/nodejs/bin:${PATH}"
# install deps
npm i

# generate key for paths etc
export CI_BUILD_KEY=$(uuidgen | cut -d "-" -f 1)

# launch the server
sudo -E ci/bin/launch-server.sh &

# wait for server to launch
sleep 10

# launch csi-sanity
sudo -E ci/bin/launch-csi-sanity.sh
