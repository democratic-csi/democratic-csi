#!/bin/bash

set -e
set -x

trap 'kill -- -$(ps -o pgid= $PID | grep -o '[0-9]*')' EXIT
#trap 'kill -- -$PGID' EXIT
#trap 'sudo kill -- -$PGID' EXIT
#trap 'sudo kill $(jobs -p)' EXIT
#trap "trap - SIGTERM && kill -- -$$" SIGINT SIGTERM EXIT

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
#sudo -E ci/bin/launch-csi-sanity.sh

# kill all processes of the session
#sudo kill $(ps -s $$ -o pid=) || true
