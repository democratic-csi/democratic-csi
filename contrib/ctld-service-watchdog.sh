#!/bin/bash

# watch the ctld pid file and ensure the service is actually running

while [ 1 ]; do
  sleep 5
  ps -p $(cat /var/run/ctld.pid) | grep ctld &>/dev/null || {
    echo "ctld not running, restarting"

    echo "regen ctld config"
    midclt call etc.generate ctld &>/dev/null

    echo "restart ctld service"
    /etc/rc.d/ctld restart &>/dev/null
  }
done
