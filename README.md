![Image](https://img.shields.io/docker/pulls/democraticcsi/democratic-csi.svg)
![Image](https://img.shields.io/github/workflow/status/democratic-csi/democratic-csi/CI?style=flat-square)

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
  - `zfs-local-ephemeral-inline` (provisions node-local zfs datasets)
  - `zfs-local-dataset` (provision node-local volume as dataset)
  - `zfs-local-zvol` (provision node-local volume as zvol)
  - `synology-iscsi` experimental (manages volumes to share over iscsi)
  - `lustre-client` (crudely provisions storage using a shared lustre
    share/directory for all volumes)
  - `nfs-client` (crudely provisions storage using a shared nfs share/directory
    for all volumes)
  - `smb-client` (crudely provisions storage using a shared smb share/directory
    for all volumes)
  - `local-hostpath` (crudely provisions node-local directories)
  - `node-manual` (allows connecting to manually created smb, nfs, lustre,
    oneclient, and iscsi volumes, see sample PVs in the `examples` directory)
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

## Node Prep

You should install/configure the requirements for both nfs and iscsi.

### cifs

```
RHEL / CentOS
sudo yum install -y cifs-utils

Ubuntu / Debian
sudo apt-get install -y cifs-utils
```

### nfs

```
RHEL / CentOS
sudo yum install -y nfs-utils

Ubuntu / Debian
sudo apt-get install -y nfs-common
```

### iscsi

Note that `multipath` is supported for the `iscsi`-based drivers. Simply setup
multipath to your liking and set multiple portals in the config as appropriate.

If you are running Kubernetes with rancher/rke please see the following:

- https://github.com/rancher/rke/issues/1846

```
RHEL / CentOS

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


Ubuntu / Debian

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

### freenas-smb

If using with Windows based machines you may need to enable guest access (even
if you are connecting with credentials)

```
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters AllowInsecureGuestAuth -Value 1
Restart-Service LanmanWorkstation -Force
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

Due to current limits in the kubernetes tooling it is not possible to use the
`local-hostpath` driver but support is implemented in this project and will
work as soon as kubernetes support is available.

```
# ensure all updates are installed

# enable the container feature
Enable-WindowsOptionalFeature -Online -FeatureName Containers –All

# create symbolic link due to current limitations in the driver-registrar container
New-Item -ItemType SymbolicLink -Path "C:\registration\" -Target "C:\var\lib\kubelet\plugins_registry\"

# install a HostProcess compatible kubernetes
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
mind, any ssh/shell/etc requirements below can be safely ignored. Also note the
following known issues:

- https://jira.ixsystems.com/browse/NAS-111870
- https://github.com/democratic-csi/democratic-csi/issues/112
- https://github.com/democratic-csi/democratic-csi/issues/101

Ensure the following services are configurged and running:

- ssh (if you use a password for authentication make sure it is allowed)
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

### ZoL (zfs-generic-nfs, zfs-generic-iscsi, zfs-generic-smb)

Ensure ssh and zfs is installed on the nfs/iscsi server and that you have installed
`targetcli`.

The driver executes many commands over an ssh connection. You may consider
disabling all the `motd` details for the ssh user as it can spike the cpu
unecessarily:

- https://askubuntu.com/questions/318592/how-can-i-remove-the-landscape-canonical-com-greeting-from-motd
- https://linuxconfig.org/disable-dynamic-motd-and-news-on-ubuntu-20-04-focal-fossa-linux
- https://github.com/democratic-csi/democratic-csi/issues/151 (some notes on
  using delegated zfs permissions)

```
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
```

### Synology (synology-iscsi)

Ensure iscsi manager has been installed and is generally setup/configured. DSM 6.3+ is supported.

## Helm Installation

```
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

### openshift

`democratic-csi` generally works fine with openshift. Some special parameters
need to be set with helm (support added in chart version `0.6.1`):

```
# for sure required
--set node.rbac.openshift.privileged=true
--set node.driver.localtimeHostPath=false

# unlikely, but in special circumstances may be required
--set controller.rbac.openshift.privileged=true
```

### Nomad

`democratic-csi` works with Nomad in a functioning but limted capacity. See the [Nomad docs](docs/nomad.md) for details.

## Multiple Deployments

You may install multiple deployments of each/any driver. It requires the following:

- Use a new helm release name for each deployment
- Make sure you have a unique `csiDriver.name` in the values file
- Use unqiue names for your storage classes (per cluster)
- Use a unique parent dataset (ie: don't try to use the same parent across deployments or clusters)

# Snapshot Support

Install beta (v1.17+) CRDs (once per cluster):

- https://github.com/kubernetes-csi/external-snapshotter/tree/master/client/config/crd

```
kubectl apply -f snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f snapshot.storage.k8s.io_volumesnapshots.yaml
```

Install snapshot controller (once per cluster):

- https://github.com/kubernetes-csi/external-snapshotter/tree/master/deploy/kubernetes/snapshot-controller

```
# replace namespace references to your liking
kubectl apply -f rbac-snapshot-controller.yaml
kubectl apply -f setup-snapshot-controller.yaml
```

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

# Sponsors

A special shout out to the wonderful sponsors of the project!

[![ixSystems](https://www.ixsystems.com/wp-content/uploads/2021/06/ix_logo_200x47.png "ixSystems")](http://ixsystems.com/)

# Related

- https://github.com/nmaupu/freenas-provisioner
- https://github.com/travisghansen/freenas-iscsi-provisioner
- https://datamattsson.tumblr.com/post/624751011659202560/welcome-truenas-core-container-storage-provider
- https://github.com/dravanet/truenas-csi
- https://github.com/SynologyOpenSource/synology-csi
- https://github.com/openebs/zfs-localpv
