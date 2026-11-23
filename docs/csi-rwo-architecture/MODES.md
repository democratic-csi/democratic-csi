# iSCSI controller publish modes

Applies to `zfs-generic-iscsi`.

## Configuration

Set `iscsi.controllerPublishMode` in the driver configuration:

```yaml
iscsi:
  controllerPublishMode: 2
```

The default is **2** when the option is omitted.

| Mode | Behavior |
| --- | --- |
| `0` | Legacy behavior: no `PUBLISH_UNPUBLISH_VOLUME` capability; controller publish/unpublish disabled. |
| `1` | Stateless controller publish/unpublish: validates the request and volume, without persistent node ownership. |
| `2` | Persistent exclusive node ownership: records the CSI node ID in ZFS and rejects a conflicting publish. |

## Mode 2 ownership semantics

The ZVOL user property `democratic-csi:publish_owner` stores the current CSI node ID. A per-volume `flock` on the ZFS host serializes read/compare/write operations; the lock itself is transient, but the ZFS property persists across controller restarts.

- Publish on an unowned volume assigns the requesting node.
- Repeated publish by the same node succeeds.
- Publish by a different node returns `FAILED_PRECONDITION`.
- Unpublish by the owner releases the property.
- Unpublish when unowned, or after the volume has been deleted, succeeds.
- Unpublish with a different explicit node ID succeeds without clearing another node's ownership.
- Unpublish without a node ID releases an existing owner; callers must ensure this is appropriate for the attachment lifecycle.

No timeout-based eviction or automatic takeover is implemented. Recovery from a failed owner may require administrator intervention.

## Scope and limitations

Mode 2 enforces **CSI controller-level node ownership**, not storage-level fencing. It does not disconnect established iSCSI sessions or forcibly stop I/O from a former initiator. Target-specific LIO ACL/session fencing is not part of this implementation.

CSI controller requests identify nodes, not individual pods. For pod-level exclusivity, use Kubernetes `ReadWriteOncePod` (RWOP) where supported. RWO alone is not a guarantee of one pod.

The ZFS host must support `flock`, allow lock-file creation in `/run`, and permit the configured ZFS property operations. The existing CreateVolume and node-side iSCSI login/mount paths remain responsible for target creation and data access.

## Validation

End-to-end testing on Debian 13/k3s with ZFS/iSCSI verified:

- Mode 2 attach and owner assignment on AMD64.
- Rejection of a competing attach with `FAILED_PRECONDITION`.
- Idempotent cleanup of a non-owner attachment request.
- Regular detach, ownership release, and takeover by a different AMD64 node.
- Native AMD64 and ARM64 image builds combined into an OCI multi-platform index.
- Successful ARM64 CSI node-plugin rollout and AMD64-to-ARM64 volume takeover.
- Preserved file content `persistent-volume-check` after the takeover and owner property set to `pi1`.

These tests do not establish fencing guarantees or exhaustively cover node failure and recovery scenarios.
