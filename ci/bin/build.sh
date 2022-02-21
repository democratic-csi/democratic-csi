#!/bin/bash

set -e
set -x

export PATH="/usr/local/lib/nodejs/bin:${PATH}"
# install deps
npm i

# tar node_modules to keep the number of files low to upload
tar -zcvf node_modules.tar.gz node_modules
