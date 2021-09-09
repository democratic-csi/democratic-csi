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
