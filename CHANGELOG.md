# v1.8.1

Released 2023-02-25

- minor fixes
- updated `nvmeof` docs

# v1.8.0

Released 2023-02-23

- `nvmeof` support

# v1.7.7

Released 2022-10-17

- support `csi.access_modes` config value in all zfs-based drivers
- bump deps

# v1.7.6

Released 2022-08-06

- support fo `talos.dev` clusters
- dep bumps

# v1.7.5

Released 2022-08-02

- improved ipv6 iscsi support
- allow using `blkid` for filesystem detection on block devices

# v1.7.4

Released 2022-07-29

- improved ipv6 iscsi support

# v1.7.3

Released 2022-07-28

- more stringent block device lookup logic (see #215)
- ipv6 iscsi support
- dependency bumps
- minor fixes throughout

# v1.7.2

Released 2022-06-28

- support for inode stats
- doc updates
- bump deps

# v1.7.1

Released 2022-06-14

- support for the alpha TrueNAS SCALE 22.12
- Fix invalid class reference

# v1.7.0

Released 2022-06-08

The windows release.

- windows smb, iscsi, and local-hostpath support (requires chart `v0.13.0+`)
- ntfs, exfat, vfat fs support
- `zfs-generic-smb` driver
- synology improvements
  - DSM7 support
  - synology enhancements to allow templates to be configured at various
    'levels'
- testing improvements
  - support (for testing) generating volume_id from name
  - test all the smb variants
  - test all nfs/smb client drivers
- misc fixes
  - wait for chown/chmod jobs to complete (freenas)
  - general improvement to smb behavior throughout
  - better logging
  - better sudo logic throughout
  - minor fixes throughout
- more robust logic for connecting to iscsi devices with partition tables
- massive performance improvement for ssh-based drivers (reusing existing
  connection instead of new connection per-command)
- dep bumps
- trimmed container images
- windows container images for 2019 and 2022

# v1.6.3

Released 2022-04-08

- dep bumps
- more secure permissions on the socket file

# v1.6.2

Released 2022-04-06

- dep bumps
- optimize via object instance reuse of various clients etc
- graceful shutdown of the grpc server

# v1.6.1

Released 2022-03-23

- include `rsync` binary in docker image (see #166)
- minor improvements to logging
- bump deps

# v1.6.0

Released 2022-03-16

This is a **massive** release with substantial changes. Ideally this release
should be installed with chart version `>=0.11.0`. Make note that due to the
updated base image from `buster` to `bullseye` that the filesystem tools have
all been updated as well (`mkfs.foo`, `resize2fs`, `fsck.foo`, etc).

To facilitate the removal `grpc-uds` package a new sister project was created:

https://github.com/democratic-csi/csi-grpc-proxy

Not all environments require the usage of the proxy, but it is enabled by
default with `helm` chart versions `>=0.11.0`.

- update `nodejs` version to `v16`
  - remove dependency on `grpc-uds` package (replaced entirely by
    `@grpc/grpc-js`)
  - remove dependency on `request` package (replaced by `axios`)
  - use native `timeout` functionality for `spawn` operations
- update http clients to use `keep-alive` logic
- add a default 30s `timeout` to `iscsiadm` commands
- base docker image on `bullseye`
- support for `btrfs` as a `fs_type`
- support `s390x` and `ppc64le` docker images

# v1.5.4

Released 2022-03-03

- more descriptive error message for breaking changes introduced in `v1.5.3`

# v1.5.3

Released 2022-03-02

- support for running `freenas-iscsi` and `freenas-nfs` `sudo`-less (see #151)
  - BREAKING CHANGE for `freenas-nfs`, if set `datasetPermissionsUser` and
    `datasetPermissionsGroup` must be numeric user/group IDs, alpha values such
    as `root` and `wheel` will no longer work
- more robust `chown` / `chmod` logic for all zfs drivers
- allow for setting extent comment/description in `freenas-iscsi` and
  `freenas-api-iscsi` (see #158)

# v1.5.2

Released 2022-02-24

- proper capacity reporting for `controller-client-common`

# v1.5.1

Released 2022-02-23

- fix ci flakes
- better support running `zfs` commands as non-root with `delegated`
  permissions

# v1.5.0

Released 2022-02-23

- massive ci overhaul
  - add additional drivers
  - add additional TrueNAS server versions
  - only build `node_modules` once by using artifacts
  - support allow/block listing specific tests
  - better logic waiting for driver socket to appear
- introduce `zfs-local-dataset` driver (see #148)
- introduce `zfs-local-zvol` driver (see #148)
- introduce `local-hostpath` driver
- support manually provisioned (`node-manual`) `oneclient` volumes

# v1.4.4

Released 2021-12-11

- better adherence to expected csi behavior when volume request for less than
  minimum volume size is requested (see #137)
- avoid unnecessary data copy for `ListVolumes` operation

# v1.4.3

Released 2021-12-01

- more appropriate handling of `size_bytes` for snapshots
- more robust handling of `NodePublishVolume` to ensure the staging path is
  actually mounted
- allow control of the `mount` / `umount` / `findmnt` command timeout via
  `MOUNT_DEFAULT_TIMEOUT` env var
- minor fix for `zfs-generic-iscsi` with `targetCli` to work-around Ubuntu
  18:04 bug (see #127)

# v1.4.2

Released 2021-09-29

- general improvements to help ci
- cover most drivers with ci

# v1.4.1

Released 2021-09-21

- `k8s-csi-cleaner` script (see #81)
- bump deps

# v1.4.0

Released 2021-09-21

- more advanced logic for iscsi naming limits (allowing > 63 chars in certain
  circumstances, SCALE, linux, FreeBSD 13+)
- various updates to support running the csi-test tool and conform to expected
  responses/behaviors (full conformance for several drivers!)
- default `fs_type` during `NodeStageVolume` when omitted by `CO`
- automatcally add `guest` mount option to `cifs` shares when creds are absent
- fix `ListVolumes` and `ListSnapshot` behavior on various `zfs-generic-*` and
  `freenas-*` drivers

# v1.3.2

Released 2021-09-09

- fix missing `break` in the `node-manual` driver using `smb` / `cifs`

# v1.3.1

Released 2021-09-08

- support using a template for nfs share comment in `freenas-nfs` and
  `freenas-api-nfs` (see #115)

# v1.3.0

Released 2021-09-02

- use `ghcr.io` for images as well as docker hub (#90)
- introduce api-only drivers for freenas (`freenas-api-*`)
- `smb-client` driver which creates folders on an smb share
- `lustre-client` driver which creates folders on a lustre share
  attaching to various volumes which have been pre-provisioned by the operator
- `synology-iscsi` driver
- various documentation improvements
- support for csi versions `1.4.0` and `1.5.0`
- reintroduce advanced options that allow control over `fsck` (#85)
- advanced options for customizing `mkfs` commands
- better handling of stale nfs connections
- do not log potentially sensitive data in mount commands
- timeouts on various commands to improve driver operations under adverse
  conditions
- various fixes and improvements throughout
- dependency bumps

# v1.2.0

Released 2021-05-12

- add `node-manual` driver

# v1.1.3

Released 2021-04-25

- remove `--force` from unmounts
- proper `iqn` logic for rescans

# v1.1.2

Released 2021-04-12

- fix for hostname based portals
- dependency bumps

# v1.1.1

Released 2021-04-12

- rescan iscsi sessions after login during stage call

# v1.1.0

Released 2021-02-21

- support for csi-v1.3.0
- fix a snapshot issue when requested with specific `snapshot_id`

# v1.0.1

Released 2021-01-29

- targetCli fixes when used in conjunction with `nameTemplate` (see #49)
- multi-stage docker builds to shrink image size dramatically
- using pre-compiled grpc binaries to dramatically speed build times
- dep updates
- remove `fsck` during stage operations due to sig-storage recommendations (see #52)

# v1.0.0

Released 2021-01-07

- initial release
