#!/bin/bash

set -e
set -x

export PATH="/usr/local/lib/nodejs/bin:${PATH}"
# install deps
npm i
