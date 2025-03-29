
# Proxy driver

Proxy driver allow you to run several drivers in one instance of democratic-csi.

Usually democratic-csi requires you to run a separate instance for each storage class.
This is heavily implied by the CSI protocol.

However, it is still _possible_ to have several storage classes work via a single CSI driver.
The `proxy` driver makes the best effort to allow dynamic storage classes.

This file has user documentation for proxy driver. Technical details that are relevant only for development can be found [here](../src/driver/controller-proxy/compatibility.md).

## Terminology

"Proxy" is the driver created via `driver: proxy` in the main config.
Other drivers are referred to as "real driver" or "underlying driver".

"Connection" is equivalent to a democratic-csi deployment without a proxy.
Each connection has a separate `.yaml` config file.
Each real driver is associated with a single connection name.

## Compatibility

Drivers that are tested and work without issues:

- `freenas-nfs`
- `freenas-iscsi`
- `freenas-api-nfs`
- `freenas-api-iscsi`
- `zfs-generic-nfs`
- `zfs-generic-iscsi`
- `zfs-generic-nvmeof`
- `local-hostpath`

Drivers that are not tested but should work fine:

- `freenas-smb`
- `freenas-api-smb`
- `zfs-generic-smb`
- `synology-iscsi`
- `nfs-client`
- `smb-client`
- `lustre-client`
- `node-manual`
- `zfs-local-dataset`
- `zfs-local-zvol`

Drivers that are known to be incompatible with proxy:

- `objectivefs`
- `zfs-local-ephemeral-inline`

All `local` drivers need `proxy.nodeTopology.type == node` to work properly.

## Config layout

Like all other drivers, proxy driver needs the main config file. See [proxy.yaml example](../examples/proxy.yaml).
Additionally, proxy needs config files for other drivers to be in the container filesystem.

Initially proxy doesn't know what real drivers to use.
In Kubernetes you configure real drivers via `parameters.connection` field in a Storage Class.
In other Container Orchestrators look for equivalent settings.

In the example `proxy.configFolder` value is `/mnt/connections/`.
This means that proxy will look for real driver config files in this folder.

Config file must have the following name: `<connection-name>.yaml`.

Connection names are arbitrary, you just need to make sure that name of the config file
matches connection name from the storage class.

Connection configuration can be added and updated dynamically,
as long as you make sure that files mounted into democratic-csi driver container are updated.

## Limitations

Proxy driver has a few limitations.

Since it provides a common interface for several drivers, these drivers need to be similar enough.
For example, you can't mix `local-hostpath` and `freenas-nfs` drivers, because they simply need different modes of deployment.
Generally, you can mix drivers if it's possible to switch between them by just changing config file.

Another limitation is connection name length.
Connection name SHOULD be short. It is added as a prefix into Volume Handle value. Volume handles have limited maximum length.
If your volume handle is already very long, adding connection name to it may cause volume creation to fail.
Whether or not this is relevant at all for you depends on your real driver config.
For example, in `freenas-` drivers Volume Handle length depends on length of `datasetParentName` parameter.

You will probably be fine when using connection name under 20 symbols.
You can probably use longer names, but the shorter the better.

Another limitation is that connection name is saved in volumes.
Connection name MUST be immutable.
If you create a volume, and then change connection name, you will get errors at different operations.
You may still be able to mount this volume, but volume size expansion or volume deletion will not work anymore.
It would be analogous to deleting the whole democratic-csi deployment when not using proxy driver.

If you want to change connection name, you need to add a new config file for new connection,
and create a new storage class that will use this new connection.
You can then delete all volumes that are using the old connection, and only then you can delete the old connection config.

## Simple k8s example

Imagine that currently you have several deployments of democratic-csi
with different configs that you want to merge into a single deployment.

First set democratic-csi [config values for proxy](../examples/proxy.yaml) (here is a minimalistic example):

```yaml
driver: proxy
proxy:
  configFolder: /mnt/connections/
```

Then adjust your helm values for democratic-csi deployment:

- (optional) delete all built-in storage classes
- (required) add extra volumes to the controller deployment

```yaml
csiDriver:
  name: org.democratic-csi.proxy
controller:
  extraVolumes:
  - name: connections
    secret:
      secretName: connections
  driver:
    extraVolumeMounts:
    - name: connections
      mountPath: /mnt/connections
```

Then create a secret for config files that will contain real driver config later:

```bash
# don't forget to adjust namespace
kubectl create secret generic connections
```

Then you can deploy democratic-csi with proxy driver.
Now you should have an empty deployment that works
but can't create any real drivers or connect to any real backend.

Let's add connections to proxy:
you need to update the `connections` secret.
Let's say that you need 2 storage classes: `nfs` and `iscsi`.
You need to have 2 separate config files for them.

```bash
# don't forget to adjust namespace
kubectl create secret generic connections \
  --from-file example-nfs.yaml=./path/to/nfs/config.yaml \
  --from-file example-iscsi.yaml=./path/to/iscsi/config.yaml \
  -o yaml --dry-run=client | kl apply -f -
```

As you can see, you don't need to restart democratic-csi to add or update connections.
If you change the `connections` secret too quickly, then you may need to wait a few seconds
for files to get remounted info filesystem, but no restart is needed.

Then create corresponding storage classes:

```yaml
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs
provisioner: org.democratic-csi.proxy
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  connection: example-nfs
  fsType: nfs
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: iscsi
provisioner: org.democratic-csi.proxy
reclaimPolicy: Delete
allowVolumeExpansion: true
parameters:
  connection: example-iscsi
  fsType: ext4
```

Now you should be able to create volumes using these 2 storage classes.

Notice that storage class name does not match connection name.
Also, local file names don't match connection name.
This is done to make example easier to understand.

In real deployment you'll probably want to keep local file names, connection names,
and mounted file names synced for easier management.
