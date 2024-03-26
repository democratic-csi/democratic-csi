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
: "${NVMETVENV:="${SCRIPTDIR}/nvmet-venv"}"

export PATH=${HOME}/.local/bin:${PATH}

main() {

  kernel_modules
  nvmetcli ls &>/dev/null || {
    setup_venv
    install_nvmetcli
  }
  nvmetcli_restore

}

kernel_modules() {

  modules=()
  modules+=("nvmet")
  modules+=("nvmet-fc")
  modules+=("nvmet-rdma")
  modules+=("nvmet-tcp")

  for module in "${modules[@]}"; do
    modprobe "${module}"
  done

}

setup_venv() {

  rm -rf ${NVMETVENV}
  python -m venv ${NVMETVENV} --without-pip --system-site-packages
  activate_venv
  curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py
  python get-pip.py
  rm get-pip.py
  deactivate_venv

}

activate_venv() {

  . ${NVMETVENV}/bin/activate

}

deactivate_venv() {

  deactivate

}

install_nvmetcli() {

  if [[ ! -d nvmetcli ]]; then
    git clone git://git.infradead.org/users/hch/nvmetcli.git
  fi

  cd nvmetcli

  activate_venv

  # install to root home dir
  python3 setup.py install --install-scripts=${HOME}/.local/bin

  # install to root home dir
  pip install configshell_fb

  # remove source
  cd "${SCRIPTDIR}"
  rm -rf nvmetcli

  deactivate_venv

}

nvmetcli_restore() {

  activate_venv
  cd "${SCRIPTDIR}"
  nvmetcli restore "${NVMETCONFIG}"
  deactivate_venv
  touch /var/run/nvmet-config-loaded
  chmod +r /var/run/nvmet-config-loaded

}

main
