# CSI controller-side iSCSI attachment coordination

This document describes the `zfs-generic-iscsi` controller publish implementation and its boundaries. See [MODES.md](MODES.md) for configuration and mode-specific behavior.

## Responsibility boundaries

| Component | Responsibility |
| --- | --- |
| Kubernetes | Pod scheduling and VolumeAttachment attach/detach coordination |
| CSI controller | Validate controller publish/unpublish and, in mode 2, coordinate node ownership |
| CSI node plugin | iSCSI login/logout and mount/unmount |
| ZFS | ZVOL storage and persistent owner property |
| iSCSI target (e.g. LIO) | Export volumes and enforce its configured access policy |

The driver does not reimplement Kubernetes pod scheduling or attachment orchestration. Controller-side node ownership is a separate safety check, not a replacement for Kubernetes access modes.

## Design

Mode 0 retains legacy controller behavior. Mode 1 implements stateless controller publish/unpublish. Mode 2, the current default, persists the owning CSI node ID in the ZFS property `democratic-csi:publish_owner`.

Mode 2 serializes each ZVOL's ownership update using a host-side `flock`, preventing concurrent publish requests from both claiming the same unowned ZVOL. The lock file is not a persistent lease. Ownership is only released through the appropriate unpublish operation or explicit administrative recovery; it is not evicted on a timer.

Publish to a different node is rejected with `FAILED_PRECONDITION`. A non-owner unpublish is idempotent and must not clear another node's ownership. This distinction was validated using a competing Kubernetes VolumeAttachment.

## Access-mode and fencing limitations

Kubernetes `ReadWriteOnce` (RWO) is node-scoped. For single-pod use, `ReadWriteOncePod` (RWOP) should be considered separately.

Persistent CSI ownership is **not storage fencing**. In particular, rejecting a new ControllerPublishVolume request does not terminate an already established iSCSI session or guarantee that an old initiator can no longer perform I/O.

LIO ACL experiments showed that removing an ACL could eventually lead to a write I/O error, but did not demonstrate immediate termination of the existing session. ACL-based fencing and session termination remain out of scope and should be assessed separately before claiming storage-side exclusivity.

A failed node may leave the persistent ownership property assigned. This is intentional: the driver does not assume that a timed-out node has stopped I/O. Safe recovery may require administrator intervention and confirmation that the old initiator is no longer accessing the volume.

## Tested behavior

End-to-end tests on Debian 13/k3s with ZFS-backed iSCSI confirmed controller-side ownership assignment, conflicting attach rejection, idempotent non-owner detach cleanup, normal detach, and takeover by a second AMD64 node.

The same test volume was then detached from an AMD64 worker and attached to an ARM64 Raspberry Pi worker using a multi-platform CSI image built from commit `124ee01`. The ARM64 pod started successfully, read the existing `persistent-volume-check` file, and the ZFS owner property reported `pi1`.

These are integration results for the tested environment, not proof of storage fencing or comprehensive failure recovery.

## Follow-up work

LIO-specific storage fencing, forced iSCSI session termination, and recovery policies for unreachable owners should be evaluated independently of this PR.
