#!/bin/env bash

npm install

git clone https://github.com/kubernetes-csi/csi-test /tmp/csi-test
pushd /tmp/csi-test 
make
sudo cp /tmp/csi-test/cmd/csi-sanity/csi-sanity /usr/local/bin
popd
rm -rf /tmp/csi-test

sudo apt update