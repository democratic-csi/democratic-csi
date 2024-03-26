#!/bin/bash

# v1.6.0
VERSION=${1}

curl -v -o "csi-${VERSION}.proto" https://raw.githubusercontent.com/container-storage-interface/spec/${VERSION}/csi.proto
