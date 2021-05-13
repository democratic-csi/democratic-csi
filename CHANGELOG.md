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
