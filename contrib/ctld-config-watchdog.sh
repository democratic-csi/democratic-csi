#!/bin/bash

# under certain circumstances high concurrency requests to the FreeNAS/TrueNAS
# API can result in an invalid /etc/ctl.conf written to disk
# this script attempts to mitigate those failures by forcing a rebuild of the
# file using info strictly from the sqlite DB

# can test with this
# logger -t ctld "error in configuration file"

while [ 1 ]; do
  egrep -m 1 "ctld.*error in configuration file" <(tail -n 0 -F /var/log/messages) &>/dev/null

  echo "regen ctld config"
  midclt call etc.generate ctld &>/dev/null

  echo "reload ctld service"
  /etc/rc.d/ctld reload &>/dev/null
done
