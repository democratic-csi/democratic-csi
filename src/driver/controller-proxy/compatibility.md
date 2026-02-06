
# Proxy driver compatibility

There are 2 challenges with the proxy driver:

1. Proxy needs dynamic state. CSI spec implies that dynamic state must be external,
which isn't ideal for small deployments, and is incompatible with democratic-csi.

2. Proxy must provide a common set of capabilities for all drivers it represents.

A great discussion of difficulties per storage class state can be found here:
- https://github.com/container-storage-interface/spec/issues/370

This file contains implementation details relevant for development.
If you are searching for user documentation and deployment example go [here](../../../docs/proxy-driver.md).

## Terminology and structure

"Proxy" is the driver created via `driver: proxy` in the main config.
Other drivers are referred to as "real driver" and "underlying driver".

"Connection" is a way to distinguish real drivers in proxy driver calls

- Connection name is set in storage class parameters
- Connection name is stored in volume handle
- Connection name is used as part of config file path

All config files must be mounted into democratic-csi filesystem.
They can be added, updated and removed dynamically.

## CSI features

Generally most features are supported.

However, some calls will not work:

- `ListVolumes`: storage class context is missing
- - https://github.com/container-storage-interface/spec/issues/461
- `ListSnapshots`: TODO: can be implemented. Would require adding snapshot secret

`NodeGetInfo` works but it brings additional challenges.
Node info is common for all storage classes.
If different drivers need different output in `NodeGetInfo`, they can't coexist.
See [node info support notes](./nodeInfo.md)

## Driver compatibility

Proxy driver has the following minimal requirements for real underlying drivers:

- Node methods should not use config values
- - This can be lifted
- - This is added because drivers use only volume context for mounting, and sometimes secrets
- - - There is one exception to this rule, and I would argue that that driver is just broken
- Driver should not need any exotic capabilities, since capabilities are shared
- Driver should use `CreateVolume`, so that proxy can set proper `volume_id`
- Controller publishing is not supported, see [Controller publish support](#controller-publish-support)

Proxy advertises that it supports most CSI methods.
If some methods are missing from underlying driver,
proxy will throw `INVALID_ARGUMENT` error.
Some methods are expected to be missing from some of the underlying drivers. In such cases proxy returns default value:

- `GetCapacity` returns infinite capacity when underlying driver does not report capacity

## Volume ID format

- `volume_id` format: `v:connection-name/original-handle`
- `snapshot_id` format: `s:connection-name/original-handle`

Where:

- `v`, `s` - fixed prefix
- - Allows to check that volume ID was created using proxy driver
- `connection-name` - identifies connection for all CSI calls
- `original-handle` - `volume_id` handle created by the underlying driver

## Controller publish support

`ControllerPublishVolume` is not implemented because currently no driver need this.
Implementation would need to replace `node_id` just like other methods replace `volume_id`.

See [node info support notes](./nodeInfo.md)

## Incompatible drivers

- `zfs-local-ephemeral-inline`: proxy can't set volume_id in `CreateVolume` to identify underlying driver
- - are inline-ephemeral and standard drivers even compatible?
- `objectivefs`: `NodeStageVolume` uses driver parameters
- - `NodeStageVolume` needs `this.options` in `getDefaultObjectiveFSInstance`
- - Other node methods don't need driver options
- - Possible fix: add support for config values for node methods
- - Possible fix: add public pool data into volume attributes, move private data (if any) into a secret

## Volume cloning and snapshots

Cloning works without any adjustments when both volumes use the same connection.
If the connection is different:
- TODO: Same driver, same server
- - It's up to driver to add support
- - Support is easy: just need to get proper source location in the CreateVolume
- TODO: Same driver, different servers
- - It's up to driver to add support
- - Example: zfs send-receive
- - Example: file copy between nfs servers
- Different drivers: block <-> file: unlikely to be practical
- - Users should probably do such things manually, by mounting both volumes into a pod
- Different drivers: same filesystem type
- - Drivers should implement generic export and import functions
- - For example: TrueNas -> generic-zfs can theoretically be possible via zfs send
- - For example: nfs -> nfs can theoretically be possible via file copy
- - How to coordinate different drivers?
