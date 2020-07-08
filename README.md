# Introduction

`democratic-csi` implements the `csi` (container storage interface) spec
providing storage for various container orchestration systems (ie: Kubernetes).

The current focus is providing storage via iscsi/nfs from zfs-based storage
systems, predominantly `FreeNAS / TrueNAS` and `ZoL` on `Ubuntu`.

The current drivers implement depth and breadth of the `csi` spec, so you have
access to resizing, snapshots, etc, etc.

`democratic-csi` is 2 things:

- several implementations of `csi` drivers
  - freenas-nfs (manages zfs datasets to share over nfs)
  - freenas-iscsi (manages zfs zvols to share over iscsi)
  - zfs-generic-nfs (works with any ZoL installation...ie: Ubuntu)
  - zfs-generic-iscsi (works with any ZoL installation...ie: Ubuntu)
  - zfs-local-ephemeral-inline (provisions node-local zfs datasets)
- framework for developing `csi` drivers

If you have any interest in providing a `csi` driver, simply open an issue to
discuss. The project provides an extensive framework to build from making it
relatively easy to implement new drivers.

# Installation

Predominantly 2 things are needed:

- node prep: https://netapp-trident.readthedocs.io/en/stable-v20.04/kubernetes/operations/tasks/worker.html
- deploy the driver into the cluster (`helm` chart provided with sample
  `values.yaml`)

You should install/configure the requirements for both nfs and iscsi.

If you are running Kubernetes with rancher/rke please see the following:

- https://github.com/rancher/rke/issues/1846

## Helm Installation

```
helm repo add democratic-csi https://democratic-csi.github.io/charts/
helm repo update
helm search democratic-csi/

# copy proper values file from https://github.com/democratic-csi/charts/tree/master/stable/democratic-csi/examples
# edit as appropriate
# examples are from helm v2, alter as appropriate for v3

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

## Multiple Deployments

You may install multiple deployments of each/any driver. It requires the following:

- Use a new helm release name for each deployment
- Make sure you have a unique `csiDriver.name` in the values file
- Use unqiue names for your storage classes (per cluster)
- Use a unique parent dataset (ie: don't try to use the same parent across deployments or clusters)
