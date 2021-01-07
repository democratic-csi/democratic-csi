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
  - `zfs-generic-nfs` (works with any ZoL installation...ie: Ubuntu)
  - `zfs-generic-iscsi` (works with any ZoL installation...ie: Ubuntu)
  - `zfs-local-ephemeral-inline` (provisions node-local zfs datasets)
  - `nfs-client` (crudely provisions storage using a shared nfs share/directory for all volumes)
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

## Guides

- https://jonathangazeley.com/2021/01/05/using-truenas-to-provide-persistent-storage-for-kubernetes/

## Node Prep

You should install/configure the requirements for both nfs and iscsi.

Follow the instructions here: https://netapp-trident.readthedocs.io/en/stable-v20.04/kubernetes/operations/tasks/worker.html

Note that `multipath` is supported for the `iscsi`-based drivers. Simply setup
multipath to your liking and set multiple portals in the config as appropriate.

If you are running Kubernetes with rancher/rke please see the following:

- https://github.com/rancher/rke/issues/1846

### freenas-smb

If using with Windows based machines you may need to enable guest access (even
if you are connecting with credentiasl)

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

## Server Prep

Server preparation depends slightly on which `driver` you are using.

### FreeNAS (freenas-nfs, freenas-iscsi, freenas-smb)

The recommended version of FreeNAS is 11.3+, however the driver should work
with much older versions as well.

Ensure the following services are configurged and running:

- ssh (if you use a password for authentication make sure it is allowed)
- ensure `zsh`, `bash`, or `sh` is set as the root shell, `csh` gives false errors due to quoting
- nfs
- iscsi
  - when using the FreeNAS API concurrently the `/etc/ctl.conf` file on the
    server can become invalid, some sample scripts are provided in the
    `contrib` directory to clean things up
    ie: copy the script to the server and directly and run - `./ctld-config-watchdog-db.sh | logger -t ctld-config-watchdog-db.sh &`
    please read the scripts and set the variables as appropriate for your server.
  - ensure you have pre-emptively created portal, group, auth
- smb

In addition, if you want to use a non-root user for the ssh operations you may
create a `csi` user and then run `visudo` directly from the console. Make sure
the line for the `csi` user has `NOPASSWD` added (note this can get reset by
FreeNAS if you alter the user via the GUI later):

```
csi ALL=(ALL) NOPASSWD:ALL
```

Starting with TrueNAS CORE 12 it is also possible to use an `apiKey` instead of
the `root` password for the http connection.

Issues to review:

- https://jira.ixsystems.com/browse/NAS-108519
- https://jira.ixsystems.com/browse/NAS-108520
- https://jira.ixsystems.com/browse/NAS-108521
- https://jira.ixsystems.com/browse/NAS-108522
- https://jira.ixsystems.com/browse/NAS-107219

### ZoL (zfs-generic-nfs, zfs-generic-iscsi)

Ensure ssh and zfs is installed on the nfs/iscsi server and that you have installed
`targetcli`.

- `sudo yum install targetcli -y`
- `sudo apt-get -y install targetcli-fb`

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

# Related

- https://github.com/nmaupu/freenas-provisioner
- https://github.com/travisghansen/freenas-iscsi-provisioner
- https://datamattsson.tumblr.com/post/624751011659202560/welcome-truenas-core-container-storage-provider
