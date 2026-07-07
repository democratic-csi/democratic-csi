# Storage Class Parameters

Some drivers support different settings for volumes. These can be configured via the driver configuration and/or storage
classes.

## `synology-iscsi`

The `synology-iscsi` driver supports several storage class parameters. Note however that not all parameters/values are
supported for all backing file systems and LUN type. The following options are available:

### Configure Storage Classes

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: synology-iscsi
parameters:
  fsType: ext4
  # The following options affect the LUN representing the volume. These options are passed directly to the Synology API.
  # The following options are known.
  lunTemplate: |
    type: BLUN       # Btrfs thin provisioning
    type: BLUN_THICK # Btrfs thick provisioning
    type: THIN       # Ext4 thin provisioning
    type: ADV        # Ext4 thin provisioning with legacy advanced feature set
    type: FILE       # Ext4 thick provisioning
    description: Some Description

    # Only for thick provisioned volumes. Known values:
    # 0: Buffered Writes
    # 3: Direct Write
    direct_io_pattern: 0

    # Device Attributes. See below for more info
    dev_attribs:
    - dev_attrib: emulate_tpws
      enable: 1
    - ...

  # The following options affect the iSCSI target. These options will be passed directly to the Synology API.
  # The following options are known.
  targetTemplate: |
    has_header_checksum: false
    has_data_checksum: false

    # Note that this option requires a compatible filesystem. Use 0 for unlimited sessions.
    max_sessions: 0
    multi_sessions: true
    max_recv_seg_bytes: 262144
    max_send_seg_bytes: 262144

    # Use this to disable authentication. To configure authentication see below
    auth_type: 0
```

#### About LUN Types

The availability of the different types of LUNs depends on the filesystem used on your Synology volume. For Btrfs volumes
you can use `BLUN` and `BLUN_THICK` volumes. For Ext4 volumes you can use `THIN`, `ADV` or `FILE` volumes. These
correspond to the options available in the UI.

#### About `dev_attribs`

Most of the LUN options are configured via the `dev_attribs` list. This list can be specified both in the `lunTemplate`
of the global configuration and in the `lunTemplate` of the `StorageClass`. If both lists are present they will be merged
(with the `StorageClass` taking precedence). The following `dev_attribs` are known to work:

- `emulate_tpws`: Hardware-assisted zeroing
- `emulate_caw`: Hardware-assisted locking
- `emulate_3pc`: Hardware-assisted data transfer
- `emulate_tpu`: Space Reclamation
- `emulate_fua_write`: Enable the FUA iSCSI command (DSM 7+)
- `emulate_sync_cache`: Enable the Sync Cache iSCSI command (DSM 7+)
- `can_snapshot`: Enable snapshots for this volume. Only works for thin provisioned volumes.

### Configure Snapshot Classes

`synology-iscsi` can also configure different parameters on snapshot classes:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: synology-iscsi-snapshot
parameters:
  # This inline yaml object will be passed to the Synology API when creating the snapshot.
  lunSnapshotTemplate: |
    is_locked: true

    # https://kb.synology.com/en-me/DSM/tutorial/What_is_file_system_consistent_snapshot
    # Note that app consistent snapshots require a working Synology Storage Console. Otherwise both values will have
    # equivalent behavior.
    is_app_consistent: true
```

Note that it is currently not supported by Synology devices to restore a snapshot onto a different volume. You can
create volumes from snapshots, but you should use the same `StorageClass` as the original volume of the snapshot did.

### Enabling CHAP Authentication

You can enable CHAP Authentication for `StorageClass`es by supplying an appropriate `StorageClass` secret (see the
[documentation](https://kubernetes-csi.github.io/docs/secrets-and-credentials-storage-class.html) for more details). You
can use the same password for alle volumes of a `StorageClass` or use different passwords per volume.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: synology-iscsi-chap
parameters:
  fsType: ext4
  lunTemplate: |
    type: BLUN
    description: iSCSI volumes with CHAP Authentication
secrets:
  # Use this to configure a single set of credentials for all volumes of this StorageClass
  csi.storage.k8s.io/provisioner-secret-name: chap-secret
  csi.storage.k8s.io/provisioner-secret-namespace: default
  # Use substitutions to use different credentials for volumes based on the PVC
  csi.storage.k8s.io/provisioner-secret-name: "${pvc.name}-chap-secret"
  csi.storage.k8s.io/provisioner-secret-namespace: "${pvc.namespace}"
...
---
# Use a secret like this to supply CHAP credentials.
apiVersion: v1
kind: Secret
metadata:
  name: chap-secret
stringData:
  lunTemplate: |
    ...
  targetTemplate: |
    # Client Credentials
    user: client
    password: MySecretPassword
    # Mutual CHAP Credentials. If these are specified mutual CHAP will be enabled.
    mutualUser: server
    mutualPassword: MyOtherPassword
  lunSnapshotTemplate: |
    ...
```

Note that CHAP authentication will only be enabled if the secret contains a username and password. If e.g. a password is
missing CHAP authentication will not be enabled (but the volume will still be created). You cannot automatically
enable/disable CHAP or change the password after the volume has been created.

If the secret itself is referenced but not present, the volume will not be created.

## ZFS drivers (`zfs-generic-*`, `zfs-local-*`, `freenas-*`/`truenas-*`, `freenas-api-*`/`truenas-api-*`)

By default the ZFS/dataset options are taken from the driver configuration and apply to every volume the driver
provisions. A subset of these options can additionally be overridden on a **per-`StorageClass`** and even
**per-`PersistentVolumeClaim`** basis, allowing different volumes to use different settings without deploying multiple
driver instances.

This is supported by all ZFS-backed drivers:

- `zfs-generic-nfs`, `zfs-generic-smb`, `zfs-generic-iscsi`, `zfs-generic-nvmeof`
- `zfs-local-dataset`, `zfs-local-zvol`
- `freenas-nfs`, `freenas-smb`, `freenas-iscsi`, `freenas-nvmeof` (and the `truenas-*` aliases) — SSH-based
- `freenas-api-nfs`, `freenas-api-smb`, `freenas-api-iscsi`, `freenas-api-nvmeof` (and the `truenas-api-*` aliases) — API-based

### Overridable options

Only the following options may be overridden. Any other value present in an override document is ignored:

| Option | Applies to | Notes |
| --- | --- | --- |
| `zfs.zvolBlocksize` | `iscsi` / `nvmeof` (block volumes) | Only honored at volume **creation** time; `volblocksize` is immutable afterwards. |
| `zfs.zvolDedup` | `iscsi` / `nvmeof` (block volumes) | e.g. `on`, `off`, `verify`. |
| `zfs.zvolCompression` | `iscsi` / `nvmeof` (block volumes) | e.g. `lz4`, `gzip-9`. |
| `zfs.zvolEnableReservation` | `iscsi` / `nvmeof` (block volumes) | Controls sparse vs. reserved (thick) volumes. |
| `zfs.datasetProperties` | all | Arbitrary ZFS properties applied to the dataset. Supports Handlebars templating against `parameters`. |

The `zvol*` options only have an effect on the block drivers (`iscsi` / `nvmeof`), which create a ZFS `volume`. For the
`nfs` / `smb` drivers (which create a ZFS `filesystem`) only `zfs.datasetProperties` is meaningful.

### Per-`StorageClass` override

Add a `config` parameter to the `StorageClass` containing a YAML/JSON document with the options to override. The document
mirrors the structure of the driver configuration file:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: freenas-iscsi-16k
parameters:
  fsType: ext4
  config: |
    zfs:
      zvolBlocksize: "16K"
      zvolCompression: "lz4"
      zvolDedup: "off"
      zvolEnableReservation: false
      datasetProperties:
        # Handlebars templating against the CSI request parameters is supported
        comments: "provisioned for {{ parameters.[csi.storage.k8s.io/pvc/namespace] }}"
provisioner: org.democratic-csi.iscsi
```

### Per-`PersistentVolumeClaim` override

To let individual PVCs override options, enable `load-config-from-pvc` on the `StorageClass` and place the override
document in the PVC's `democratic-csi.org/config` annotation:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: freenas-iscsi
parameters:
  fsType: ext4
  load-config-from-pvc: "true"
provisioner: org.democratic-csi.iscsi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-fast-volume
  annotations:
    democratic-csi.org/config: |
      zfs:
        zvolBlocksize: "64K"
        zvolCompression: "off"
spec:
  storageClassName: freenas-iscsi
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
```

Reading the PVC requires the external-provisioner to forward PVC metadata to the driver (i.e. it must be started with
`--extra-create-metadata=true`, which is the default in the democratic-csi charts). When enabled, the effective options
are resolved in the following order of increasing precedence: driver configuration → `StorageClass` `config` →
PVC `democratic-csi.org/config` annotation.

> The `config` parameter (and the `democratic-csi.org/config` annotation) may also be namespaced per-driver or
> per-instance using the standard prefixes, e.g. `democratic-csi.org/config`,
> `democratic-csi.org/<driver>/config` or `democratic-csi.org/<instance_id>/config`.
