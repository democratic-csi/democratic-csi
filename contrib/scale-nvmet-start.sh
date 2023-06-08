#!/bin/bash

# simple script to 'start' nvmet on TrueNAS SCALE
#
# to reinstall nvmetcli simply rm /usr/sbin/nvmetcli

# debug
#set -x

# exit non-zero
set -e

SCRIPTDIR="$(
  cd -- "$(dirname "$0")" >/dev/null 2>&1
  pwd -P
)"
cd "${SCRIPTDIR}"

: "${NVMETCONFIG:="${SCRIPTDIR}/nvmet-config.json"}"

export PATH=${HOME}/.local/bin:${PATH}

modules=()
modules+=("nvmet")
modules+=("nvmet-fc")
modules+=("nvmet-rdma")
modules+=("nvmet-tcp")

for module in "${modules[@]}"; do
  modprobe "${module}"
done

which nvmetcli &>/dev/null || {
  which pip &>/dev/null || {
    wget -O get-pip.py https://bootstrap.pypa.io/get-pip.py
    python get-pip.py --user
    rm get-pip.py
  }

  if [[ ! -d nvmetcli ]]; then
    git clone git://git.infradead.org/users/hch/nvmetcli.git
  fi

  cd nvmetcli

  # install to root home dir
  python3 setup.py install --user

  # install to root home dir
  pip install configshell_fb --user

  # remove source
  cd "${SCRIPTDIR}"
  rm -rf nvmetcli
}

cd "${SCRIPTDIR}"
nvmetcli restore "${NVMETCONFIG}"

touch /var/run/nvmet-config-loaded
chmod +r /var/run/nvmet-config-loaded
