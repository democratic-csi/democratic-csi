#!/bin/bash

WAIT_TIME_SECS=30
USERNAME="root"
PASSWORD="secret"
BASE_URL="http://localhost"
LIMIT=1000

while [ 1 ]; do
  sleep "${WAIT_TIME_SECS}"

  # ctl targets
  CTL_TARGET_COUNT=$(ctladm portlist | grep iqn | wc -l | sed 's/^[ \t]*//;s/[ \t]*$//')
  echo "ctl target count: ${CTL_TARGET_COUNT}"

  # ctl extents
  CTL_EXTENT_COUNT=$(ctladm devlist | tail -n +2 | wc -l | sed 's/^[ \t]*//;s/[ \t]*$//')
  echo "ctl extent count: ${CTL_EXTENT_COUNT}"

  # ctl luns
  CTL_LUN_COUNT=$(ctladm lunlist | wc -l | sed 's/^[ \t]*//;s/[ \t]*$//')
  echo "ctl lun count: ${CTL_LUN_COUNT}"

  # db targets
  DB_TARGET_COUNT=$(curl --user "${USERNAME}:${PASSWORD}" "${BASE_URL}/api/v2.0/iscsi/target?limit=${LIMIT}" 2>/dev/null | jq length)
  echo "DB target count: ${DB_TARGET_COUNT}"

  # db extents
  DB_EXTENT_COUNT=$(curl --user "${USERNAME}:${PASSWORD}" "${BASE_URL}/api/v2.0/iscsi/extent?limit=${LIMIT}" 2>/dev/null | jq length)
  echo "DB extent count: ${DB_EXTENT_COUNT}"

  # db luns
  DB_LUN_COUNT=$(curl --user "${USERNAME}:${PASSWORD}" "${BASE_URL}/api/v2.0/iscsi/targetextent?limit=${LIMIT}" 2>/dev/null | jq length)
  echo "DB lun count: ${DB_LUN_COUNT}"

  REGEN=0

  if [[ ${CTL_TARGET_COUNT} -ne ${DB_TARGET_COUNT} ]]; then
    REGEN=1
  fi

  if [[ ${CTL_EXTENT_COUNT} -ne ${DB_EXTENT_COUNT} ]]; then
    REGEN=1
  fi

  if [[ ${CTL_LUN_COUNT} -ne ${DB_LUN_COUNT} ]]; then
    REGEN=1
  fi

  if [[ ${REGEN} -eq 1 ]]; then
    echo "regen ctld config"
    midclt call etc.generate ctld &>/dev/null

    echo "reload ctld service"
    /etc/rc.d/ctld reload &>/dev/null
  fi

done
