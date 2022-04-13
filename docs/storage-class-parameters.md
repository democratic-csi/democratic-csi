# Storage Class Parameters

Some drivers support different settings for volumes. These can be configured via the driver configuration and/or storage classes.

## `synology-iscsi`
The `synology-iscsi` driver supports several storage class parameters. Note however that not all parameters/values are supported for all backing file systems and LUN type. The following options are available:

### Configure Storage Classes
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: synology-iscsi
parameters:
    fsType: ext4
    # The following options affect the LUN representing the volume
    volume: /volume2 # Optional. Override the volume on which the LUN will be created.
    lunType: BLUN       # Btrfs thin provisioning
    lunType: BLUN_THICK # Btrfs thick provisioning
    lunType: THIN       # Ext4 thin provisioning
    lunType: ADV        # Ext4 thin provisioning with legacy advanced feature set
    lunType: FILE       # Ext4 thick provisioning
    lunDescription: Some Description
    hardwareAssistedZeroing: true
    hardwareAssistedLocking: true
    hardwareAssistedDataTransfer: true
    spaceReclamation: true
    allowSnapshots: true
    enableFuaWrite: false
    enableSyncCache: false
    ioPolicy: Buffered  # or Direct
    # The following options affect the iSCSI target
    headerDigenst: false
    dataDigest: false
    maxSessions: 1 # Note that this option requires a compatible filesystem
    maxRecieveSegmentBytes: 262144
    maxSendSegmentBytes: 262144
...
```

About extended features:
- For `BLUN_THICK` volumes only hardware assisted zeroing and locking can be configured.
- For `THIN` volumes none of the extended features can be configured.
- For `ADV` volumes only space reclamation can be configured.
- For `FILE` volumes only hardware assisted locking can be configured.
- `ioPolicy` is only available for thick provisioned volumes.

### Configure Snapshot Classes
`synology-iscsi` can also configure different parameters on snapshot classes:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: synology-iscsi-snapshot
parameters:
  isLocked: true
  # https://kb.synology.com/en-me/DSM/tutorial/What_is_file_system_consistent_snapshot
  consistency: AppConsistent # Or CrashConsistent
...
```

### Enabling CHAP Authentication
You can enable CHAP Authentication for `StorageClass`es by supplying an appropriate `StorageClass` secret (see the [documentation](https://kubernetes-csi.github.io/docs/secrets-and-credentials-storage-class.html) for more details). You can use the same password for alle volumes of a `StorageClass` or use different passwords per volume.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: synology-iscsi-chap
parameters:
  fsType: ext4
  lunType: BLUN
  lunDescription: iSCSI volumes with CHAP Authentication
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
  # Client Credentials
  user: client
  password: MySecretPassword
  # Mutual CHAP Credentials. If these are specified mutual CHAP will be enabled.
  mutualUser: server
  password: MyOtherPassword
```

Note that CHAP authentication will only be enabled if the secret is correctly configured. If e.g. a password is missing CHAP authentication will not be enabled (but the volume will still be created). You cannot automatically enable/disable CHAP or change the password after the volume has been created.

If the secret itself is referenced but not present, the volume will not be created.
