#!/bin/bash

set -e
set -x
TEMPLATE_CONFIG=""

ROOT_DIR="$(dirname "$(realpath "$0")")"

while [[ "$#" -gt 0 ]]; do
  case $1 in
    -c|--config) TEMPLATE_CONFIG="$(realpath "$2")"; shift ;;
    *) echo "Unknown parameter passed: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "${TEMPLATE_CONFIG}" ]; then
  echo "Error: --config or -c parameter is required."
  exit 1
fi

if [ ! -f $ROOT_DIR/secrets.env ]; then
  echo "Error: secrets.env file not found."
  exit 1
fi

source $ROOT_DIR/secrets.env # needs to have exported variables

# generate key for paths etc
export CI_BUILD_KEY=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 8)

export TEMPLATE_CONFIG_FILE=${TEMPLATE_CONFIG}

$ROOT_DIR/../ci/bin/run.sh