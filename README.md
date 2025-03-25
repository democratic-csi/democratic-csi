![Image](https://img.shields.io/docker/pulls/democraticcsi/democratic-csi.svg)
![Image](https://img.shields.io/github/actions/workflow/status/democratic-csi/democratic-csi/main.yml?branch=master&style=flat-square)
[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/democratic-csi)](https://artifacthub.io/packages/search?repo=democratic-csi)

# Introduction

`democratic-csi` implements the `csi` (container storage interface) spec
providing storage for various container orchestration systems (ie: Kubernetes).

The current focus is providing storage via iscsi/nfs from zfs-based storage
systems, predominantly `FreeNAS / TrueNAS` and `ZoL` on `Ubuntu`.

The current drivers implement the depth and breadth of the `csi` spec, so you
have access to resizing, snapshots, clones, etc functionality.

`democratic-csi` is 2 things:

- several implementations of `csi` drivers
  - `freenas-nfs` (manages zfs datasets to share over nfs)
  - `freenas-iscsi` (manages zfs zvols to share over iscsi)
  - `freenas-smb` (manages zfs datasets to share over smb)
  - `freenas-api-nfs` experimental use with SCALE only (manages zfs datasets to share over nfs)
  - `freenas-api-iscsi` experimental use with SCALE only (manages zfs zvols to share over iscsi)
  - `freenas-api-smb` experimental use with SCALE only (manages zfs datasets to share over smb)
  - `zfs-generic-nfs` (works with any ZoL installation...ie: Ubuntu)
  - `zfs-generic-iscsi` (works with any ZoL installation...ie: Ubuntu)
  - `zfs-generic-smb` (works with any ZoL installation...ie: Ubuntu)
  - `zfs-generic-nvmeof` (works with any ZoL installation...ie: Ubuntu)
  - `zfs-local-ephemeral-inline` (provisions node-local zfs datasets)
  - `zfs-local-dataset` (provision node-local volume as dataset)
  - `zfs-local-zvol` (provision node-local volume as zvol)
  - `synology-iscsi` experimental (manages volumes to share over iscsi)
  - `objectivefs` (manages objectivefs volumes)
  - `lustre-client` (crudely provisions storage using a shared lustre
    share/directory for all volumes)
  - `nfs-client` (crudely provisions storage using a shared nfs share/directory
    for all volumes)
  - `smb-client` (crudely provisions storage using a shared smb share/directory
    for all volumes)
  - `local-hostpath` (crudely provisions node-local directories)
  - `node-manual` (allows connecting to manually created smb, nfs, lustre,
    oneclient, nvmeof, and iscsi volumes, see sample PVs in the `examples`
    directory)
- framework for developing `csi` drivers

If you have any interest in providing a `csi` driver, simply open an issue to
discuss. The project provides an extensive framework to build from making it
relatively easy to implement new drivers.

# Installation

Predominantly 3 things are needed:

- node prep (ie: your kubernetes cluster nodes)
- server prep (ie: your storage server)
- deploy the driver into the cluster (`helm` chart provided with sample
  `values.yaml`)

## Community Guides

- https://jonathangazeley.com/2021/01/05/using-truenas-to-provide-persistent-storage-for-kubernetes/
- https://www.lisenet.com/2021/moving-to-truenas-and-democratic-csi-for-kubernetes-persistent-storage/
- https://gist.github.com/admun/4372899f20421a947b7544e5fc9f9117 (migrating
  from `nfs-client-provisioner` to `democratic-csi`)
- https://gist.github.com/deefdragon/d58a4210622ff64088bd62a5d8a4e8cc
  (migrating between storage classes using `velero`)
- https://github.com/fenio/k8s-truenas (NFS/iSCSI over API with TrueNAS Scale)

## Node Prep

You should install/configure the requirements for both nfs and iscsi.

### cifs

```bash
# RHEL / CentOS
sudo yum install -y cifs-utils

# Ubuntu / Debian
sudo apt-get install -y cifs-utils
```

### nfs

```bash
# RHEL / CentOS
sudo yum install -y nfs-utils

# Ubuntu / Debian
sudo apt-get install -y nfs-common
```

### iscsi

Note that `multipath` is supported for the `iscsi`-based drivers. Simply setup
multipath to your liking and set multiple portals in the config as appropriate.

If you are running Kubernetes with rancher/rke please see the following:

- https://github.com/rancher/rke/issues/1846

#### RHEL / CentOS

```bash
# Install the following system packages
sudo yum install -y lsscsi iscsi-initiator-utils sg3_utils device-mapper-multipath

# Enable multipathing
sudo mpathconf --enable --with_multipathd y

# Ensure that iscsid and multipathd are running
sudo systemctl enable iscsid multipathd
sudo systemctl start iscsid multipathd

# Start and enable iscsi
sudo systemctl enable iscsi
sudo systemctl start iscsi
```

#### Ubuntu / Debian

```
# Install the following system packages
sudo apt-get install -y open-iscsi lsscsi sg3-utils multipath-tools scsitools

# Enable multipathing
sudo tee /etc/multipath.conf <<-'EOF'
defaults {
    user_friendly_names yes
    find_multipaths yes
}
EOF

sudo systemctl enable multipath-tools.service
sudo service multipath-tools restart

# Ensure that open-iscsi and multipath-tools are enabled and running
sudo systemctl status multipath-tools
sudo systemctl enable open-iscsi.service
sudo service open-iscsi start
sudo systemctl status open-iscsi
```

#### [Talos](https://www.talos.dev/)

To use iscsi storage in kubernetes cluster in talos these steps are needed which are similar to the ones explained in https://www.talos.dev/v1.1/kubernetes-guides/configuration/replicated-local-storage-with-openebs-jiva/#patching-the-jiva-installation

##### Patch nodes

since talos does not have iscsi support by default, the iscsi extension is needed
create a `patch.yaml` file with

```yaml
- op: add
  path: /machine/install/extensions
  value:
    - image: ghcr.io/siderolabs/iscsi-tools:v0.1.1
```

and apply the patch across all of your nodes

```bash
talosctl -e <endpoint ip/hostname> -n <node ip/hostname> patch mc -p @patch.yaml
```

the extension will not activate until you "upgrade" the nodes, even if there is no update, use the latest version of talos installer.
VERIFY THE TALOS VERSION IN THIS COMMAND BEFORE RUNNING IT AND READ THE [OpenEBS Jiva](https://www.talos.dev/v1.1/kubernetes-guides/configuration/replicated-local-storage-with-openebs-jiva/#patching-the-jiva-installation).
upgrade all of the nodes in the cluster to get the extension

```bash
talosctl -e <endpoint ip/hostname> -n <node ip/hostname> upgrade --image=ghcr.io/siderolabs/installer:v1.1.1
```

in your `values.yaml` file make sure to enable these settings

```yaml
node:
  hostPID: true
  driver:
    extraEnv:
      - name: ISCSIADM_HOST_STRATEGY
        value: nsenter
      - name: ISCSIADM_HOST_PATH
        value: /usr/local/sbin/iscsiadm
    iscsiDirHostPath: /usr/local/etc/iscsi
    iscsiDirHostPathType: ""
```

and continue your democratic installation as usuall with other iscsi drivers.

#### Privileged Namespace

democratic-csi requires privileged access to the nodes, so the namespace should allow for privileged pods. One way of doing it is via [namespace labels](https://kubernetes.io/docs/tasks/configure-pod-container/enforce-standards-namespace-labels/).
Add the followin label to the democratic-csi installation namespace `pod-security.kubernetes.io/enforce=privileged`

```
kubectl label --overwrite namespace democratic-csi pod-security.kubernetes.io/enforce=privileged
```

### nvmeof

```bash
# not required but likely helpful (tools are included in the democratic images
# so not needed on the host)
apt-get install -y nvme-cli

# get the nvme fabric modules
apt-get install linux-generic

# ensure the nvmeof modules get loaded at boot
cat <<EOF > /etc/modules-load.d/nvme.conf
nvme
nvme-tcp
nvme-fc
nvme-rdma
EOF

# load the modules immediately
modprobe nvme
modprobe nvme-tcp
modprobe nvme-fc
modprobe nvme-rdma

# nvme has native multipath or can use DM multipath
# democratic-csi will gracefully handle either configuration
# RedHat recommends DM multipath (nvme_core.multipath=N)
cat /sys/module/nvme_core/parameters/multipath

# kernel arg to enable/disable native multipath
nvme_core.multipath=N
```

### zfs-local-ephemeral-inline

This `driver` provisions node-local ephemeral storage on a per-pod basis. Each
node should have an identically named zfs pool created and avaialble to the
`driver`. Note, this is _NOT_ the same thing as using the docker zfs storage
driver (although the same pool could be used). No other requirements are
necessary.

- https://github.com/kubernetes/enhancements/blob/master/keps/sig-storage/20190122-csi-inline-volumes.md
- https://kubernetes-csi.github.io/docs/ephemeral-local-volumes.html

### zfs-local-{dataset,zvol}

This `driver` provisions node-local storage. Each node should have an
identically named zfs pool created and avaialble to the `driver`. Note, this is
_NOT_ the same thing as using the docker zfs storage driver (although the same
pool could be used). Nodes should have the standard `zfs` utilities installed.

In the name of ease-of-use these drivers by default report `MULTI_NODE` support
(`ReadWriteMany` in k8s) however the volumes will implicity only work on the
node where originally provisioned. Topology contraints manage this in an
automated fashion preventing any undesirable behavior. So while you may
provision `MULTI_NODE` / `RWX` volumes, any workloads using the volume will
always land on a single node and that node will always be the node where the
volume is/was provisioned.

### local-hostpath

This `driver` provisions node-local storage. Each node should have an
identically name folder where volumes will be created.

In the name of ease-of-use these drivers by default report `MULTI_NODE` support
(`ReadWriteMany` in k8s) however the volumes will implicity only work on the
node where originally provisioned. Topology contraints manage this in an
automated fashion preventing any undesirable behavior. So while you may
provision `MULTI_NODE` / `RWX` volumes, any workloads using the volume will
always land on a single node and that node will always be the node where the
volume is/was provisioned.

The nature of this `driver` also prevents the enforcement of quotas. In short
the requested volume size is generally ignored.

### windows

Support for Windows was introduced in `v1.7.0`. Currently support is limited
to kubernetes nodes capabale of running `HostProcess` containers. Support was
tested against `Windows Server 2019` using `rke2-v1.24`. Currently any of the
`-smb` and `-iscsi` drivers will work. Support for `ntfs` was added to the
linux nodes as well (using the `ntfs3` driver) so volumes created can be
utilized by nodes with either operating system (in the case of `cifs` by both
simultaneously).

If using any `-iscsi` driver be sure your iqns are always fully lower-case by
default (https://github.com/PowerShell/PowerShell/issues/17306).

Due to current limits in the kubernetes tooling it is not possible to use the
`local-hostpath` driver but support is implemented in this project and will
work as soon as kubernetes support is available.

```powershell
# ensure all updates are installed

# enable the container feature
Enable-WindowsOptionalFeature -Online -FeatureName Containers –All

# install a HostProcess compatible kubernetes

# smb support
# If using with Windows based machines you may need to enable guest access
# (even if you are connecting with credentials)
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters AllowInsecureGuestAuth -Value 1
Restart-Service LanmanWorkstation -Force

# iscsi
# enable iscsi service and mpio as appropriate
Get-Service -Name MSiSCSI
Set-Service -Name MSiSCSI -StartupType Automatic
Start-Service -Name MSiSCSI
Get-Service -Name MSiSCSI

# mpio
Get-WindowsFeature -Name 'Multipath-IO'
Add-WindowsFeature -Name 'Multipath-IO'

Enable-MSDSMAutomaticClaim -BusType "iSCSI"
Disable-MSDSMAutomaticClaim -BusType "iSCSI"

Get-MSDSMGlobalDefaultLoadBalancePolicy
Set-MSDSMGlobalLoadBalancePolicy -Policy RR
```

- https://kubernetes.io/blog/2021/08/16/windows-hostprocess-containers/
- https://kubernetes.io/docs/tasks/configure-pod-container/create-hostprocess-pod/

## Server Prep

Server preparation depends slightly on which `driver` you are using.

### FreeNAS (freenas-nfs, freenas-iscsi, freenas-smb, freenas-api-nfs, freenas-api-iscsi, freenas-api-smb)

The recommended version of FreeNAS is 12.0-U2+, however the driver should work
with much older versions as well.

The various `freenas-api-*` drivers are currently EXPERIMENTAL and can only be
used with SCALE 21.08+. Fundamentally these drivers remove the need for `ssh`
connections and do all operations entirely with the TrueNAS api. With that in
mind, any ssh/shell/etc requirements below can be safely ignored. The minimum
volume size through the api is `1G` so beware that requested volumes with a
size small will be increased to `1G`. Also note the following known issues:

- https://jira.ixsystems.com/browse/NAS-111870
- https://github.com/democratic-csi/democratic-csi/issues/112
- https://github.com/democratic-csi/democratic-csi/issues/101

Ensure the following services are configurged and running:

- ssh (if you use a password for authentication make sure it is allowed)
  - https://www.truenas.com/community/threads/ssh-access-ssh-rsa-not-in-pubkeyacceptedalgorithms.101715/
  - `PubkeyAcceptedAlgorithms +ssh-rsa`
- ensure `zsh`, `bash`, or `sh` is set as the root shell, `csh` gives false errors due to quoting
- nfs
- iscsi

  - (fixed in 12.0-U2+) when using the FreeNAS API concurrently the
    `/etc/ctl.conf` file on the server can become invalid, some sample scripts
    are provided in the `contrib` directory to clean things up ie: copy the
    script to the server and directly and run - `./ctld-config-watchdog-db.sh | logger -t ctld-config-watchdog-db.sh &`
    please read the scripts and set the variables as appropriate for your server.
  - ensure you have pre-emptively created portals, initatior groups, auths
    - make note of the respective IDs (the true ID may not reflect what is
      visible in the UI)
    - IDs can be visible by clicking the the `Edit` link and finding the ID in the
      browser address bar
    - Optionally you may use the following to retrieve appropiate IDs:
      - `curl --header "Accept: application/json" --user root:<password> 'http(s)://<ip>/api/v2.0/iscsi/portal'`
      - `curl --header "Accept: application/json" --user root:<password> 'http(s)://<ip>/api/v2.0/iscsi/initiator'`
      - `curl --header "Accept: application/json" --user root:<password> 'http(s)://<ip>/api/v2.0/iscsi/auth'`
  - The maximum number of volumes is limited to 255 by default on FreeBSD (physical devices such as disks and CD-ROM drives count against this value).
    Be sure to properly adjust both [tunables](https://www.freebsd.org/cgi/man.cgi?query=ctl&sektion=4#end) `kern.cam.ctl.max_ports` and `kern.cam.ctl.max_luns` to avoid running out of resources when dynamically provisioning iSCSI volumes on FreeNAS or TrueNAS Core.

- smb

If you would prefer you can configure `democratic-csi` to use a
non-`root` user when connecting to the FreeNAS server:

- Create a non-`root` user (e.g., `csi`)

- Ensure that user has passwordless `sudo` privileges:

  ```
  csi ALL=(ALL) NOPASSWD:ALL

  # if on CORE 12.0-u3+ you should be able to do the following
  # which will ensure it does not get reset during reboots etc
  # at the command prompt
  cli

  # after you enter the truenas cli and are at that prompt
  account user query select=id,username,uid,sudo_nopasswd

  # find the `id` of the user you want to update (note, this is distinct from the `uid`)
  account user update id=<id> sudo=true
  account user update id=<id> sudo_nopasswd=true
  # optional if you want to disable password
  #account user update id=<id> password_disabled=true

  # exit cli by hitting ctrl-d

  # confirm sudoers file is appropriate
  cat /usr/local/etc/sudoers
  ```

  (note this can get reset by FreeNAS if you alter the user via the
  GUI later)

- Instruct `democratic-csi` to use `sudo` by adding the following to
  your driver configuration:

  ```
  zfs:
    cli:
      sudoEnabled: true
  ```

Starting with TrueNAS CORE 12 it is also possible to use an `apiKey` instead of
the `root` password for the http connection.

Issues to review:

- https://jira.ixsystems.com/browse/NAS-108519
- https://jira.ixsystems.com/browse/NAS-108520
- https://jira.ixsystems.com/browse/NAS-108521
- https://jira.ixsystems.com/browse/NAS-108522
- https://jira.ixsystems.com/browse/NAS-107219

### ZoL (zfs-generic-nfs, zfs-generic-iscsi, zfs-generic-smb, zfs-generic-nvmeof)

Ensure ssh and zfs is installed on the nfs/iscsi server and that you have installed
`targetcli`.

The driver executes many commands over an ssh connection. You may consider
disabling all the `motd` details for the ssh user as it can spike the cpu
unecessarily:

- https://askubuntu.com/questions/318592/how-can-i-remove-the-landscape-canonical-com-greeting-from-motd
- https://linuxconfig.org/disable-dynamic-motd-and-news-on-ubuntu-20-04-focal-fossa-linux
- https://github.com/democratic-csi/democratic-csi/issues/151 (some notes on
  using delegated zfs permissions)

```bash
####### nfs
yum install -y nfs-utils
systemctl enable --now nfs-server.service

apt-get install -y nfs-kernel-server
systemctl enable --now nfs-kernel-server.service

####### iscsi
yum install targetcli -y
apt-get -y install targetcli-fb

####### smb
apt-get install -y samba smbclient

# create posix user
groupadd -g 1001 smbroot
useradd -u 1001 -g 1001 -M -N -s /sbin/nologin smbroot
passwd smbroot (optional)

# create smb user and set password
smbpasswd -L -a smbroot

####### nvmeof
# ensure nvmeof target modules are loaded at startup
cat <<EOF > /etc/modules-load.d/nvmet.conf
nvmet
nvmet-tcp
nvmet-fc
nvmet-rdma
EOF

# load the modules immediately
modprobe nvmet
modprobe nvmet-tcp
modprobe nvmet-fc
modprobe nvmet-rdma

# install nvmetcli and systemd services
git clone git://git.infradead.org/users/hch/nvmetcli.git
cd nvmetcli

## install globally
python3 setup.py install --prefix=/usr
pip install configshell_fb

## install to root home dir
python3 setup.py install --user
pip install configshell_fb --user

# prevent log files from filling up disk
ln -sf /dev/null ~/.nvmetcli/log.txt
ln -sf /dev/null ~/.nvmetcli/history.txt

# install systemd unit and enable/start
## optionally to ensure the config file is loaded before we start
## reading/writing to it add an ExecStartPost= to the unit file
##
## ExecStartPost=/usr/bin/touch /var/run/nvmet-config-loaded
##
## in your dirver config set nvmeof.shareStrategyNvmetCli.configIsImportedFilePath=/var/run/nvmet-config-loaded
## which will prevent the driver from making any changes until the configured
## file is present
vi nvmet.service

cp nvmet.service /etc/systemd/system/
mkdir -p /etc/nvmet
systemctl daemon-reload
systemctl enable --now nvmet.service
systemctl status nvmet.service

# create the port(s) configuration manually
echo "
cd /
ls
" | nvmetcli

# do this multiple times altering as appropriate if you have/want multipath
# change the port to 2, 3.. each additional path
# the below example creates a tcp port listening on all IPs on port 4420
echo "
cd /ports
create 1
cd 1
set addr adrfam=ipv4 trtype=tcp traddr=0.0.0.0 trsvcid=4420

saveconfig /etc/nvmet/config.json
" | nvmetcli

# if running TrueNAS SCALE you can skip the above and simply copy
# contrib/scale-nvmet-start.sh to your machine and add it as a startup script
# to launch POSTINIT type COMMAND
# and then create the port(s) as mentioned above
```

### Synology (synology-iscsi)

Ensure iscsi manager has been installed and is generally setup/configured. DSM 6.3+ is supported.

### objectivefs (objectivefs)

ObjectiveFS requires the use of an _Admin Key_ to properly automate the
lifecycle of filesystems. Each deployment of the driver will point to a single
`pool` (bucket) and create individual `filesystems` within that bucket
on-demand.

Ensure the config value used for `pool` is an existing bucket. Be sure the
bucket is _NOT_ being used in fs mode (ie: the whole bucket is a single fs).

The `democratic-csi` `node` container will host the fuse mount process so
be careful to only upgrade when all relevant workloads have been drained from
the respective node. Also beware that any cpu/memory limits placed on the
container by the orchestration system will impact any ability to use the
caching, etc features of objectivefs.

- https://objectivefs.com/howto/csi-driver-objectivefs
- https://objectivefs.com/howto/csi-driver-objectivefs-kubernetes-managed
- https://objectivefs.com/howto/objectivefs-admin-key-setup
- https://objectivefs.com/features#filesystem-pool
- https://objectivefs.com/howto/how-to-create-a-filesystem-with-an-existing-empty-bucket

## Helm Installation

```bash
helm repo add democratic-csi https://democratic-csi.github.io/charts/
helm repo update
# helm v2
helm search democratic-csi/

# helm v3
helm search repo democratic-csi/

# copy proper values file from https://github.com/democratic-csi/charts/tree/master/stable/democratic-csi/examples
# edit as appropriate
# examples are from helm v2, alter as appropriate for v3

# add --create-namespace for helm v3
helm upgrade \
--install \
--values freenas-iscsi.yaml \
--namespace democratic-csi \
zfs-iscsi democratic-csi/democratic-csi

helm upgrade \
--install \
--values freenas-nfs.yaml \
--namespace democratic-csi \
zfs-nfs democratic-csi/democratic-csi
```

### Injecting environment variables

It is possible to use environment variables to configure the `democratic-csi`
driver, by setting a given field to `{env:<environment variable name>}`.
For example:

```yaml
driver:
  config:
    driver: freenas-api-nfs
    instance_id:
    httpConnection:
      protocol: http
      host: 10.0.0.1
      port: 80
      apiKey: '{env:TRUENAS_API_KEY}'
      allowInsecure: false
```

This will set the value of the `apiKey` field to the `TRUENAS_API_KEY` environment
variable.

### A note on non standard kubelet paths

Some distrobutions, such as `minikube` and `microk8s` use a non-standard
kubelet path. In such cases it is necessary to provide a new kubelet host path,
microk8s example below:

```bash
microk8s helm upgrade \
  --install \
  --values freenas-nfs.yaml \
  --set node.kubeletHostPath="/var/snap/microk8s/common/var/lib/kubelet"  \
  --namespace democratic-csi \
  zfs-nfs democratic-csi/democratic-csi
```

- microk8s - `/var/snap/microk8s/common/var/lib/kubelet`
- pivotal - `/var/vcap/data/kubelet`
- k0s - `/var/lib/k0s/kubelet`

### openshift

`democratic-csi` generally works fine with openshift. Some special parameters
need to be set with helm (support added in chart version `0.6.1`):

```bash
# for sure required
--set node.rbac.openshift.privileged=true
--set node.driver.localtimeHostPath=false

# unlikely, but in special circumstances may be required
--set controller.rbac.openshift.privileged=true
```

### Nomad

`democratic-csi` works with Nomad in a functioning but limted capacity. See the
[Nomad docs](docs/nomad.md) for details.

### Docker Swarm

- https://github.com/moby/moby/blob/master/docs/cluster_volumes.md
- https://github.com/olljanat/csi-plugins-for-docker-swarm

## Multiple Deployments

You may install multiple deployments of each/any driver. It requires the
following:

- Use a new helm release name for each deployment
- Make sure you have a unique `csiDriver.name` in the values file (within the
  same cluster)
- Use unqiue names for your storage classes (per cluster)
- Use a unique parent dataset (ie: don't try to use the same parent across
  deployments or clusters)
- For `iscsi` and `smb` be aware that the names of assets/shares are _global_
  and so collisions are possible/probable. Appropriate use of the respective
  `nameTemplate`, `namePrefix`, and `nameSuffix` configuration options will
  mitigate the issue [#210](https://github.com/democratic-csi/democratic-csi/issues/210).

# Snapshot Support

Install snapshot controller (once per cluster):

- https://github.com/democratic-csi/charts/tree/master/stable/snapshot-controller

OR

- https://github.com/kubernetes-csi/external-snapshotter/tree/master/client/config/crd
- https://github.com/kubernetes-csi/external-snapshotter/tree/master/deploy/kubernetes/snapshot-controller

Install `democratic-csi` as usual with `volumeSnapshotClasses` defined as appropriate.

- https://kubernetes.io/docs/concepts/storage/volume-snapshots/
- https://github.com/kubernetes-csi/external-snapshotter#usage
- https://github.com/democratic-csi/democratic-csi/issues/129#issuecomment-961489810

# Migrating from freenas-provisioner and freenas-iscsi-provisioner

It is possible to migrate all volumes from the non-csi freenas provisioners
to `democratic-csi`.

Copy the `contrib/freenas-provisioner-to-democratic-csi.sh` script from the
project to your workstation, read the script in detail, and edit the variables
to your needs to start migrating!

# Related

- https://github.com/nmaupu/freenas-provisioner
- https://github.com/travisghansen/freenas-iscsi-provisioner
- https://datamattsson.tumblr.com/post/624751011659202560/welcome-truenas-core-container-storage-provider
- https://github.com/dravanet/truenas-csi
- https://github.com/SynologyOpenSource/synology-csi
- https://github.com/openebs/zfs-localpv
