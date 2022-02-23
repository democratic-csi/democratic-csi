const _ = require("lodash");
const cp = require("child_process");
const os = require("os");
const fs = require("fs");
const { GrpcError, grpc } = require("../utils/grpc");
const { Mount } = require("../utils/mount");
const { OneClient } = require("../utils/oneclient");
const { Filesystem } = require("../utils/filesystem");
const { ISCSI } = require("../utils/iscsi");
const semver = require("semver");
const sleep = require("../utils/general").sleep;
const { Zetabyte } = require("../utils/zfs");

/**
 * common code shared between all drivers
 * this is **NOT** meant to work as a proxy
 * for the grpc calls meaning, it should not
 * also operate as a facade handling directly
 * the requests to the platform
 */
class CsiBaseDriver {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options || {};

    if (!this.options.hasOwnProperty("node")) {
      this.options.node = {};
    }

    if (!this.options.node.hasOwnProperty("format")) {
      this.options.node.format = {};
    }

    if (!this.options.node.hasOwnProperty("mount")) {
      this.options.node.mount = {};
    }

    if (!this.options.node.mount.hasOwnProperty("checkFilesystem")) {
      this.options.node.mount.checkFilesystem = {};
    }
  }

  /**
   * abstract way of retrieving values from parameters/secrets
   * in order of preference:
   *  - democratic-csi.org/{instance_id}/{key}
   *  - democratic-csi.org/{driver}/{key}
   *  - {key}
   *
   * @param {*} parameters
   * @param {*} key
   */
  getNormalizedParameterValue(parameters, key, driver, instance_id) {
    const normalized = this.getNormalizedParameters(
      parameters,
      driver,
      instance_id
    );
    return normalized[key];
  }

  getNormalizedParameters(parameters, driver, instance_id) {
    const normalized = JSON.parse(JSON.stringify(parameters));
    const base_key = "democratic-csi.org";
    driver = driver || this.options.driver;
    instance_id = instance_id || this.options.instance_id;

    for (const key in parameters) {
      let normalizedKey;
      let prefixLength;
      if (instance_id && key.startsWith(`${base_key}/${instance_id}/`)) {
        prefixLength = `${base_key}/${instance_id}/`.length;
        normalizedKey = key.slice(prefixLength);
        normalized[normalizedKey] = parameters[key];
        delete normalized[key];
      }

      if (driver && key.startsWith(`${base_key}/${driver}/`)) {
        prefixLength = `${base_key}/${driver}/`.length;
        normalizedKey = key.slice(prefixLength);
        normalized[normalizedKey] = parameters[key];
        delete normalized[key];
      }

      if (key.startsWith(`${base_key}/`)) {
        prefixLength = `${base_key}/`.length;
        normalizedKey = key.slice(prefixLength);
        normalized[normalizedKey] = parameters[key];
        delete normalized[key];
      }
    }

    return normalized;
  }

  async GetPluginInfo(call) {
    return {
      name: this.ctx.args.csiName,
      vendor_version: this.ctx.args.version,
    };
  }

  async GetPluginCapabilities(call) {
    let capabilities;
    const response = {
      capabilities: [],
    };

    //UNKNOWN = 0;
    // CONTROLLER_SERVICE indicates that the Plugin provides RPCs for
    // the ControllerService. Plugins SHOULD provide this capability.
    // In rare cases certain plugins MAY wish to omit the
    // ControllerService entirely from their implementation, but such
    // SHOULD NOT be the common case.
    // The presence of this capability determines whether the CO will
    // attempt to invoke the REQUIRED ControllerService RPCs, as well
    // as specific RPCs as indicated by ControllerGetCapabilities.
    //CONTROLLER_SERVICE = 1;

    // VOLUME_ACCESSIBILITY_CONSTRAINTS indicates that the volumes for
    // this plugin MAY NOT be equally accessible by all nodes in the
    // cluster. The CO MUST use the topology information returned by
    // CreateVolumeRequest along with the topology information
    // returned by NodeGetInfo to ensure that a given volume is
    // accessible from a given node when scheduling workloads.
    //VOLUME_ACCESSIBILITY_CONSTRAINTS = 2;
    capabilities = this.options.service.identity.capabilities.service || [
      "UNKNOWN",
    ];

    capabilities.forEach((item) => {
      response.capabilities.push({
        service: { type: item },
      });
    });

    //UNKNOWN = 0;
    // ONLINE indicates that volumes may be expanded when published to
    // a node. When a Plugin implements this capability it MUST
    // implement either the EXPAND_VOLUME controller capability or the
    // EXPAND_VOLUME node capability or both. When a plugin supports
    // ONLINE volume expansion and also has the EXPAND_VOLUME
    // controller capability then the plugin MUST support expansion of
    // volumes currently published and available on a node. When a
    // plugin supports ONLINE volume expansion and also has the
    // EXPAND_VOLUME node capability then the plugin MAY support
    // expansion of node-published volume via NodeExpandVolume.
    //
    // Example 1: Given a shared filesystem volume (e.g. GlusterFs),
    //   the Plugin may set the ONLINE volume expansion capability and
    //   implement ControllerExpandVolume but not NodeExpandVolume.
    //
    // Example 2: Given a block storage volume type (e.g. EBS), the
    //   Plugin may set the ONLINE volume expansion capability and
    //   implement both ControllerExpandVolume and NodeExpandVolume.
    //
    // Example 3: Given a Plugin that supports volume expansion only
    //   upon a node, the Plugin may set the ONLINE volume
    //   expansion capability and implement NodeExpandVolume but not
    //   ControllerExpandVolume.
    //ONLINE = 1;

    // OFFLINE indicates that volumes currently published and
    // available on a node SHALL NOT be expanded via
    // ControllerExpandVolume. When a plugin supports OFFLINE volume
    // expansion it MUST implement either the EXPAND_VOLUME controller
    // capability or both the EXPAND_VOLUME controller capability and
    // the EXPAND_VOLUME node capability.
    //
    // Example 1: Given a block storage volume type (e.g. Azure Disk)
    //   that does not support expansion of "node-attached" (i.e.
    //   controller-published) volumes, the Plugin may indicate
    //   OFFLINE volume expansion support and implement both
    //   ControllerExpandVolume and NodeExpandVolume.
    //OFFLINE = 2;
    capabilities = this.options.service.identity.capabilities
      .volume_expansion || ["UNKNOWN"];

    capabilities.forEach((item) => {
      response.capabilities.push({
        volume_expansion: { type: item },
      });
    });

    return response;
  }

  async Probe(call) {
    return { ready: { value: true } };
  }

  async ControllerGetCapabilities(call) {
    let capabilities;
    const response = {
      capabilities: [],
    };

    //UNKNOWN = 0;
    //CREATE_DELETE_VOLUME = 1;
    //PUBLISH_UNPUBLISH_VOLUME = 2;
    //LIST_VOLUMES = 3;
    //GET_CAPACITY = 4;
    // Currently the only way to consume a snapshot is to create
    // a volume from it. Therefore plugins supporting
    // CREATE_DELETE_SNAPSHOT MUST support creating volume from
    // snapshot.
    //CREATE_DELETE_SNAPSHOT = 5;
    //LIST_SNAPSHOTS = 6;

    // Plugins supporting volume cloning at the storage level MAY
    // report this capability. The source volume MUST be managed by
    // the same plugin. Not all volume sources and parameters
    // combinations MAY work.
    //CLONE_VOLUME = 7;

    // Indicates the SP supports ControllerPublishVolume.readonly
    // field.
    //PUBLISH_READONLY = 8;

    // See VolumeExpansion for details.
    //EXPAND_VOLUME = 9;
    capabilities = this.options.service.controller.capabilities.rpc || [
      "UNKNOWN",
    ];

    capabilities.forEach((item) => {
      response.capabilities.push({
        rpc: { type: item },
      });
    });

    return response;
  }

  async NodeGetCapabilities(call) {
    let capabilities;
    const response = {
      capabilities: [],
    };

    //UNKNOWN = 0;
    //STAGE_UNSTAGE_VOLUME = 1;
    // If Plugin implements GET_VOLUME_STATS capability
    // then it MUST implement NodeGetVolumeStats RPC
    // call for fetching volume statistics.
    //GET_VOLUME_STATS = 2;
    // See VolumeExpansion for details.
    //EXPAND_VOLUME = 3;
    capabilities = this.options.service.node.capabilities.rpc || ["UNKNOWN"];

    capabilities.forEach((item) => {
      response.capabilities.push({
        rpc: { type: item },
      });
    });

    return response;
  }

  async NodeGetInfo(call) {
    return {
      node_id: process.env.CSI_NODE_ID || os.hostname(),
      max_volumes_per_node: 0,
    };
  }

  /**
   * https://kubernetes-csi.github.io/docs/raw-block.html
   * --feature-gates=BlockVolume=true,CSIBlockVolume=true
   *
   * StagingTargetPath is always a directory even for block volumes
   *
   * NOTE: stage gets called every time publish does
   *
   * @param {*} call
   */
  async NodeStageVolume(call) {
    const driver = this;
    const mount = new Mount();
    const filesystem = new Filesystem();
    const iscsi = new ISCSI();
    let result;
    let device;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const staging_target_path = call.request.staging_target_path;
    if (!staging_target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `missing staging_target_path`
      );
    }
    const capability = call.request.volume_capability;
    if (!capability || Object.keys(capability).length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capability`);
    }
    const access_type = capability.access_type || "mount";
    const volume_context = call.request.volume_context;
    let fs_type;
    let mount_flags;
    let volume_mount_group;
    const node_attach_driver = volume_context.node_attach_driver;
    const block_path = staging_target_path + "/block_device";
    const bind_mount_flags = [];
    bind_mount_flags.push("defaults");

    const normalizedSecrets = this.getNormalizedParameters(
      call.request.secrets,
      call.request.volume_context.provisioner_driver,
      call.request.volume_context.provisioner_driver_instance_id
    );

    /*
    let mount_options = await mount.getMountOptions(staging_target_path);
    console.log(mount_options);
    console.log(await mount.getMountOptionValue(mount_options, "stripe"));
    console.log(await mount.getMountOptionPresent(mount_options, "stripee"));
    throw new Error("foobar");
    */

    if (access_type == "mount") {
      fs_type = capability.mount.fs_type;
      mount_flags = capability.mount.mount_flags || [];
      // add secrets mount_flags
      if (normalizedSecrets.mount_flags) {
        mount_flags.push(normalizedSecrets.mount_flags);
      }

      switch (node_attach_driver) {
        case "oneclient":
          // move along
          break;
        default:
          mount_flags.push("defaults");

          // https://github.com/karelzak/util-linux/issues/1429
          //mount_flags.push("x-democratic-csi.managed");
          //mount_flags.push("x-democratic-csi.staged");
          break;
      }

      if (
        semver.satisfies(driver.ctx.csiVersion, ">=1.5.0") &&
        driver.options.service.node.capabilities.rpc.includes(
          "VOLUME_MOUNT_GROUP"
        )
      ) {
        volume_mount_group = capability.mount.volume_mount_group; // in k8s this is derrived from the fsgroup in the pod security context
      }
    }

    if (call.request.volume_context.provisioner_driver == "node-manual") {
      result = await this.assertCapabilities([capability], node_attach_driver);
      if (!result.valid) {
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `invalid capability: ${result.message}`
        );
      }
    } else {
      result = await this.assertCapabilities([capability]);
      if (!result.valid) {
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `invalid capability: ${result.message}`
        );
      }
    }

    // csi spec stipulates that staging_target_path is a directory even for block mounts
    result = await filesystem.pathExists(staging_target_path);
    if (!result) {
      await filesystem.mkdir(staging_target_path, ["-p", "-m", "0750"]);
    }

    switch (node_attach_driver) {
      case "nfs":
      case "lustre":
        device = `${volume_context.server}:${volume_context.share}`;
        break;
      case "smb":
        device = `//${volume_context.server}/${volume_context.share}`;

        // if not present add guest
        let has_username = mount_flags.some((element) => {
          element = element.trim().toLowerCase();
          return element.startsWith("username=");
        });

        // prevents driver from hanging on stdin waiting for a password to be entered at the cli
        if (!has_username) {
          let has_guest = mount_flags.some((element) => {
            element = element.trim().toLowerCase();
            return element === "guest";
          });

          if (!has_guest) {
            mount_flags.push("guest");
          }
        }
        break;
      case "iscsi":
        let portals = [];
        if (volume_context.portal) {
          portals.push(volume_context.portal.trim());
        }

        if (volume_context.portals) {
          volume_context.portals.split(",").forEach((portal) => {
            portals.push(portal.trim());
          });
        }

        // ensure full portal value
        portals = portals.map((value) => {
          if (!value.includes(":")) {
            value += ":3260";
          }

          return value.trim();
        });

        // ensure unique entries only
        portals = [...new Set(portals)];

        // stores actual device paths after iscsi login
        let iscsiDevices = [];

        // stores configuration of targets/iqn/luns to connect to
        let iscsiConnections = [];
        for (let portal of portals) {
          iscsiConnections.push({
            portal,
            iqn: volume_context.iqn,
            lun: volume_context.lun,
          });
        }

        /**
         * TODO: allow sending in iscsiConnection in a raw/manual format
         * TODO: allow option to determine if send_targets should be invoked
         * TODO: allow option to control whether nodedb entry should be created by driver
         * TODO: allow option to control whether nodedb entry should be deleted by driver
         */

        for (let iscsiConnection of iscsiConnections) {
          // create DB entry
          // https://library.netapp.com/ecmdocs/ECMP1654943/html/GUID-8EC685B4-8CB6-40D8-A8D5-031A3899BCDC.html
          // put these options in place to force targets managed by csi to be explicitly attached (in the case of unclearn shutdown etc)
          let nodeDB = {
            "node.startup": "manual",
            //"node.session.scan": "manual",
          };
          const nodeDBKeyPrefix = "node-db.";
          for (const key in normalizedSecrets) {
            if (key.startsWith(nodeDBKeyPrefix)) {
              nodeDB[key.substr(nodeDBKeyPrefix.length)] =
                normalizedSecrets[key];
            }
          }
          await iscsi.iscsiadm.createNodeDBEntry(
            iscsiConnection.iqn,
            iscsiConnection.portal,
            nodeDB
          );
          // login
          await iscsi.iscsiadm.login(
            iscsiConnection.iqn,
            iscsiConnection.portal
          );

          // get associated session
          let session = await iscsi.iscsiadm.getSession(
            iscsiConnection.iqn,
            iscsiConnection.portal
          );

          // rescan in scenarios when login previously occurred but volumes never appeared
          await iscsi.iscsiadm.rescanSession(session);

          // find device name
          device = `/dev/disk/by-path/ip-${iscsiConnection.portal}-iscsi-${iscsiConnection.iqn}-lun-${iscsiConnection.lun}`;
          let deviceByPath = device;

          // can take some time for device to show up, loop for some period
          result = await filesystem.pathExists(device);
          let timer_start = Math.round(new Date().getTime() / 1000);
          let timer_max = 30;
          let deviceCreated = result;
          while (!result) {
            await sleep(2000);
            result = await filesystem.pathExists(device);

            if (result) {
              deviceCreated = true;
              break;
            }

            let current_time = Math.round(new Date().getTime() / 1000);
            if (!result && current_time - timer_start > timer_max) {
              driver.ctx.logger.warn(
                `hit timeout waiting for device node to appear: ${device}`
              );
              break;
            }
          }

          if (deviceCreated) {
            device = await filesystem.realpath(device);
            iscsiDevices.push(device);

            driver.ctx.logger.info(
              `successfully logged into portal ${iscsiConnection.portal} and created device ${deviceByPath} with realpath ${device}`
            );
          }
        }

        // let things settle
        // this will help in dm scenarios
        await sleep(2000);

        // filter duplicates
        iscsiDevices = iscsiDevices.filter((value, index, self) => {
          return self.indexOf(value) === index;
        });

        // only throw an error if we were not able to attach to *any* devices
        if (iscsiDevices.length < 1) {
          throw new GrpcError(
            grpc.status.UNKNOWN,
            `unable to attach any iscsi devices`
          );
        }

        if (iscsiDevices.length != iscsiConnections.length) {
          driver.ctx.logger.warn(
            `failed to attach all iscsi devices/targets/portals`
          );

          // TODO: allow a parameter to control this behavior in some form
          if (false) {
            throw new GrpcError(
              grpc.status.UNKNOWN,
              `unable to attach all iscsi devices`
            );
          }
        }

        // compare all device-mapper slaves with the newly created devices
        // if any of the new devices are device-mapper slaves treat this as a
        // multipath scenario
        let allDeviceMapperSlaves =
          await filesystem.getAllDeviceMapperSlaveDevices();
        let commonDevices = allDeviceMapperSlaves.filter((value) =>
          iscsiDevices.includes(value)
        );

        const useMultipath =
          iscsiConnections.length > 1 || commonDevices.length > 0;

        // discover multipath device to use
        if (useMultipath) {
          device = await filesystem.getDeviceMapperDeviceFromSlaves(
            iscsiDevices,
            false
          );

          if (!device) {
            throw new GrpcError(
              grpc.status.UNKNOWN,
              `failed to discover multipath device`
            );
          }
        }
        break;
      case "hostpath":
        result = await mount.pathIsMounted(staging_target_path);
        // if not mounted, mount
        if (!result) {
          await mount.bindMount(volume_context.path, staging_target_path);
          return {};
        } else {
          return {};
        }

        break;
      case "oneclient":
        let oneclient = new OneClient();
        device = "oneclient";
        result = await mount.deviceIsMountedAtPath(device, staging_target_path);
        if (result) {
          return {};
        }

        if (volume_context.space_names) {
          volume_context.space_names.split(",").forEach((space) => {
            mount_flags.push("--space", space);
          });
        }

        if (volume_context.space_ids) {
          volume_context.space_ids.split(",").forEach((space) => {
            mount_flags.push("--space-id", space);
          });
        }

        if (normalizedSecrets.token) {
          mount_flags.push("-t", normalizedSecrets.token);
        } else {
          if (volume_context.token) {
            mount_flags.push("-t", volume_context.token);
          }
        }

        result = await oneclient.mount(
          staging_target_path,
          ["-H", volume_context.server].concat(mount_flags)
        );

        if (result) {
          return {};
        }

        throw new GrpcError(
          grpc.status.UNKNOWN,
          `failed to mount oneclient: ${volume_context.server}`
        );

        break;
      case "zfs-local":
        // TODO: make this a geneic zb instance (to ensure works with node-manual driver)
        const zb = new Zetabyte({
          idempotent: true,
          paths: {
            zfs: "zfs",
            zpool: "zpool",
            sudo: "sudo",
            chroot: "chroot",
          },
          //logger: driver.ctx.logger,
          executor: {
            spawn: function () {
              const command = `${arguments[0]} ${arguments[1].join(" ")}`;
              return cp.exec(command);
            },
          },
          log_commands: true,
        });
        result = await zb.zfs.get(`${volume_context.zfs_asset_name}`, [
          "type",
          "mountpoint",
        ]);
        result = result[`${volume_context.zfs_asset_name}`];
        switch (result.type.value) {
          case "filesystem":
            if (result.mountpoint.value != "legacy") {
              // zfs set mountpoint=legacy <dataset>
              // zfs inherit mountpoint <dataset>
              await zb.zfs.set(`${volume_context.zfs_asset_name}`, {
                mountpoint: "legacy",
              });
            }
            device = `${volume_context.zfs_asset_name}`;
            if (!fs_type) {
              fs_type = "zfs";
            }
            break;
          case "volume":
            device = `/dev/zvol/${volume_context.zfs_asset_name}`;
            break;
          default:
            throw new GrpcError(
              grpc.status.UNKNOWN,
              `unknown zfs asset type: ${result.type.value}`
            );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unknown/unsupported node_attach_driver: ${node_attach_driver}`
        );
    }

    switch (access_type) {
      case "mount":
        let is_block = false;
        switch (node_attach_driver) {
          case "iscsi":
            is_block = true;
            break;
          case "zfs-local":
            is_block = device.startsWith("/dev/zvol/");
            break;
        }

        if (is_block) {
          // block specific logic
          if (!fs_type) {
            fs_type = "ext4";
          }

          if (await filesystem.isBlockDevice(device)) {
            // format
            result = await filesystem.deviceIsFormatted(device);
            if (!result) {
              let formatOptions = _.get(
                driver.options.node.format,
                [fs_type, "customOptions"],
                []
              );
              if (!Array.isArray(formatOptions)) {
                formatOptions = [];
              }
              await filesystem.formatDevice(device, fs_type, formatOptions);
            }

            let fs_info = await filesystem.getDeviceFilesystemInfo(device);
            fs_type = fs_info.type;

            // fsck
            result = await mount.deviceIsMountedAtPath(
              device,
              staging_target_path
            );
            if (!result) {
              // https://github.com/democratic-csi/democratic-csi/issues/52#issuecomment-768463401
              let checkFilesystem =
                driver.options.node.mount.checkFilesystem[fs_type] || {};
              if (checkFilesystem.enabled) {
                await filesystem.checkFilesystem(
                  device,
                  fs_type,
                  checkFilesystem.customOptions || [],
                  checkFilesystem.customFilesystemOptions || []
                );
              }
            }
          }
        }

        result = await mount.deviceIsMountedAtPath(device, staging_target_path);
        if (!result) {
          if (!fs_type) {
            switch (node_attach_driver) {
              case "nfs":
                fs_type = "nfs";
                break;
              case "lustre":
                fs_type = "lustre";
                break;
              case "smb":
                fs_type = "cifs";
                break;
              case "iscsi":
                fs_type = "ext4";
                break;
              default:
                break;
            }
          }
          await mount.mount(
            device,
            staging_target_path,
            ["-t", fs_type].concat(["-o", mount_flags.join(",")])
          );
        }

        if (await filesystem.isBlockDevice(device)) {
          // go ahead and expand fs (this covers cloned setups where expand is not explicitly invoked)
          switch (fs_type) {
            case "ext4":
            case "ext3":
            case "ext4dev":
              //await filesystem.checkFilesystem(device, fs_info.type);
              try {
                await filesystem.expandFilesystem(device, fs_type);
              } catch (err) {
                // mount is clean and rw, but it will not expand until clean umount has been done
                // failed to execute filesystem command: resize2fs /dev/sda, response: {"code":1,"stdout":"Couldn't find valid filesystem superblock.\n","stderr":"resize2fs 1.44.5 (15-Dec-2018)\nresize2fs: Superblock checksum does not match superblock while trying to open /dev/sda\n"}
                // /dev/sda on /var/lib/kubelet/plugins/kubernetes.io/csi/pv/pvc-4a80757e-5e87-475d-826f-44fcc4719348/globalmount type ext4 (rw,relatime,stripe=256)
                if (
                  err.code == 1 &&
                  err.stdout.includes("find valid filesystem superblock") &&
                  err.stderr.includes("checksum does not match superblock")
                ) {
                  driver.ctx.logger.warn(
                    `successful mount, unsuccessful fs resize: attempting abnormal umount/mount/resize2fs to clear things up ${staging_target_path} (${device})`
                  );

                  // try an unmount/mount/fsck cycle again just to clean things up
                  await mount.umount(staging_target_path, []);
                  await mount.mount(
                    device,
                    staging_target_path,
                    ["-t", fs_type].concat(["-o", mount_flags.join(",")])
                  );
                  await filesystem.expandFilesystem(device, fs_type);
                } else {
                  throw err;
                }
              }
              break;
            case "xfs":
              //await filesystem.checkFilesystem(device, fs_info.type);
              await filesystem.expandFilesystem(staging_target_path, fs_type);
              break;
            default:
              // unsupported filesystem
              throw new GrpcError(
                grpc.status.FAILED_PRECONDITION,
                `unsupported/unknown filesystem ${fs_type}`
              );
          }
        }

        break;
      case "block":
        //result = await mount.deviceIsMountedAtPath(device, block_path);
        result = await mount.deviceIsMountedAtPath("dev", block_path);
        if (!result) {
          result = await filesystem.pathExists(staging_target_path);
          if (!result) {
            await filesystem.mkdir(staging_target_path, ["-p", "-m", "0750"]);
          }

          result = await filesystem.pathExists(block_path);
          if (!result) {
            await filesystem.touch(block_path);
          }

          await mount.bindMount(device, block_path, [
            "-o",
            bind_mount_flags.join(","),
          ]);
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unknown/unsupported access_type: ${access_type}`
        );
    }

    return {};
  }

  /**
   * NOTE: only gets called when the last pod on the node using the volume is removed
   *
   * 1. unmount fs
   * 2. logout of iscsi if neccessary
   *
   * @param {*} call
   */
  async NodeUnstageVolume(call) {
    const driver = this;
    const mount = new Mount();
    const filesystem = new Filesystem();
    const iscsi = new ISCSI();
    let result;
    let is_block = false;
    let is_device_mapper = false;
    let block_device_info;
    let access_type = "mount";

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const staging_target_path = call.request.staging_target_path;
    if (!staging_target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `missing staging_target_path`
      );
    }
    const block_path = staging_target_path + "/block_device";
    let normalized_staging_path = staging_target_path;
    const umount_args = [];
    const umount_force_extra_args = ["--force", "--lazy"];

    //result = await mount.pathIsMounted(block_path);
    //result = await mount.pathIsMounted(staging_target_path)

    // TODO: use the x-* mount options to detect if we should delete target

    try {
      result = await mount.pathIsMounted(block_path);
    } catch (err) {
      /**
       * on stalled fs such as nfs, even findmnt will return immediately for the base mount point
       * so in the case of timeout here (base mount point and then a file/folder beneath it) we almost certainly are not a block device
       * AND the fs is probably stalled
       */
      if (err.timeout) {
        driver.ctx.logger.warn(
          `detected stale mount, attempting to force unmount: ${normalized_staging_path}`
        );
        await mount.umount(
          normalized_staging_path,
          umount_args.concat(umount_force_extra_args)
        );
        result = false; // assume we are *NOT* a block device at this point
      } else {
        throw err;
      }
    }

    if (result) {
      is_block = true;
      access_type = "block";
      block_device_info = await filesystem.getBlockDevice(block_path);
      normalized_staging_path = block_path;
    } else {
      result = await mount.pathIsMounted(staging_target_path);
      if (result) {
        let device = await mount.getMountPointDevice(staging_target_path);
        result = await filesystem.isBlockDevice(device);
        if (result) {
          is_block = true;
          block_device_info = await filesystem.getBlockDevice(device);
        }
      }
    }

    result = await mount.pathIsMounted(normalized_staging_path);
    if (result) {
      try {
        result = await mount.umount(normalized_staging_path, umount_args);
      } catch (err) {
        if (err.timeout) {
          driver.ctx.logger.warn(
            `hit timeout waiting to unmount path: ${normalized_staging_path}`
          );
          result = await mount.getMountDetails(normalized_staging_path);
          switch (result.fstype) {
            case "nfs":
            case "nfs4":
              driver.ctx.logger.warn(
                `detected stale nfs filesystem, attempting to force unmount: ${normalized_staging_path}`
              );
              result = await mount.umount(
                normalized_staging_path,
                umount_args.concat(umount_force_extra_args)
              );
              break;
            default:
              throw err;
              break;
          }
        } else {
          throw err;
        }
      }
    }

    if (is_block) {
      let realBlockDeviceInfos = [];
      // detect if is a multipath device
      is_device_mapper = await filesystem.isDeviceMapperDevice(
        block_device_info.path
      );

      if (is_device_mapper) {
        let realBlockDevices = await filesystem.getDeviceMapperDeviceSlaves(
          block_device_info.path
        );
        for (const realBlockDevice of realBlockDevices) {
          realBlockDeviceInfos.push(
            await filesystem.getBlockDevice(realBlockDevice)
          );
        }
      } else {
        realBlockDeviceInfos = [block_device_info];
      }

      // TODO: this could be made async to detach all simultaneously
      for (const block_device_info_i of realBlockDeviceInfos) {
        if (block_device_info_i.tran == "iscsi") {
          // figure out which iscsi session this belongs to and logout
          // scan /dev/disk/by-path/ip-*?
          // device = `/dev/disk/by-path/ip-${volume_context.portal}-iscsi-${volume_context.iqn}-lun-${volume_context.lun}`;
          // parse output from `iscsiadm -m session -P 3`
          let sessions = await iscsi.iscsiadm.getSessionsDetails();
          for (let i = 0; i < sessions.length; i++) {
            let session = sessions[i];
            let is_attached_to_session = false;

            if (
              session.attached_scsi_devices &&
              session.attached_scsi_devices.host &&
              session.attached_scsi_devices.host.devices
            ) {
              is_attached_to_session =
                session.attached_scsi_devices.host.devices.some((device) => {
                  if (device.attached_scsi_disk == block_device_info_i.name) {
                    return true;
                  }
                  return false;
                });
            }

            if (is_attached_to_session) {
              let timer_start;
              let timer_max;

              timer_start = Math.round(new Date().getTime() / 1000);
              timer_max = 30;
              let loggedOut = false;
              while (!loggedOut) {
                try {
                  await iscsi.iscsiadm.logout(session.target, [
                    session.persistent_portal,
                  ]);
                  loggedOut = true;
                } catch (err) {
                  await sleep(2000);
                  let current_time = Math.round(new Date().getTime() / 1000);
                  if (current_time - timer_start > timer_max) {
                    // not throwing error for now as future invocations would not enter code path anyhow
                    loggedOut = true;
                    //throw new GrpcError(
                    //  grpc.status.UNKNOWN,
                    //  `hit timeout trying to logout of iscsi target: ${session.persistent_portal}`
                    //);
                  }
                }
              }

              timer_start = Math.round(new Date().getTime() / 1000);
              timer_max = 30;
              let deletedEntry = false;
              while (!deletedEntry) {
                try {
                  await iscsi.iscsiadm.deleteNodeDBEntry(
                    session.target,
                    session.persistent_portal
                  );
                  deletedEntry = true;
                } catch (err) {
                  await sleep(2000);
                  let current_time = Math.round(new Date().getTime() / 1000);
                  if (current_time - timer_start > timer_max) {
                    // not throwing error for now as future invocations would not enter code path anyhow
                    deletedEntry = true;
                    //throw new GrpcError(
                    //  grpc.status.UNKNOWN,
                    //  `hit timeout trying to delete iscsi node DB entry: ${session.target}, ${session.persistent_portal}`
                    //);
                  }
                }
              }
            }
          }
        }
      }
    }

    if (access_type == "block") {
      // remove touched file
      result = await filesystem.pathExists(block_path);
      if (result) {
        result = await filesystem.rm(block_path);
      }
    }

    result = await filesystem.pathExists(staging_target_path);
    if (result) {
      result = await filesystem.rmdir(staging_target_path);
    }

    return {};
  }

  async NodePublishVolume(call) {
    const driver = this;
    const mount = new Mount();
    const filesystem = new Filesystem();
    let result;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const staging_target_path = call.request.staging_target_path || "";
    const target_path = call.request.target_path;
    if (!target_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing target_path`);
    }
    const capability = call.request.volume_capability;
    if (!capability || Object.keys(capability).length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capability`);
    }
    const access_type = capability.access_type || "mount";
    let mount_flags;
    let volume_mount_group;
    const readonly = call.request.readonly;
    const volume_context = call.request.volume_context;
    const bind_mount_flags = [];
    const node_attach_driver = volume_context.node_attach_driver;

    if (access_type == "mount") {
      mount_flags = capability.mount.mount_flags || [];
      bind_mount_flags.push(...mount_flags);

      if (
        semver.satisfies(driver.ctx.csiVersion, ">=1.5.0") &&
        driver.options.service.node.capabilities.rpc.includes(
          "VOLUME_MOUNT_GROUP"
        )
      ) {
        volume_mount_group = capability.mount.volume_mount_group; // in k8s this is derrived from the fsgroup in the pod security context
      }
    }

    bind_mount_flags.push("defaults");

    // https://github.com/karelzak/util-linux/issues/1429
    //bind_mount_flags.push("x-democratic-csi.managed");
    //bind_mount_flags.push("x-democratic-csi.published");

    if (readonly) bind_mount_flags.push("ro");
    // , "x-democratic-csi.ro"

    switch (node_attach_driver) {
      case "nfs":
      case "smb":
      case "lustre":
      case "oneclient":
      case "hostpath":
      case "iscsi":
      case "zfs-local":
        // ensure appropriate directories/files
        switch (access_type) {
          case "mount":
            // ensure directory exists
            result = await filesystem.pathExists(target_path);
            if (!result) {
              await filesystem.mkdir(target_path, ["-p", "-m", "0750"]);
            }

            break;
          case "block":
            // ensure target_path directory exists as target path should be a file
            let target_dir = await filesystem.dirname(target_path);
            result = await filesystem.pathExists(target_dir);
            if (!result) {
              await filesystem.mkdir(target_dir, ["-p", "-m", "0750"]);
            }

            // ensure target file exists
            result = await filesystem.pathExists(target_path);
            if (!result) {
              await filesystem.touch(target_path);
            }
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unsupported/unknown access_type ${access_type}`
            );
        }

        // ensure bind mount
        if (staging_target_path) {
          let normalized_staging_device;
          let normalized_staging_path;

          if (access_type == "block") {
            normalized_staging_path = staging_target_path + "/block_device";
          } else {
            normalized_staging_path = staging_target_path;
          }

          // sanity check to ensure the staged path is actually mounted
          result = await mount.pathIsMounted(normalized_staging_path);
          if (!result) {
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `staging path is not mounted: ${normalized_staging_path}`
            );
          }

          result = await mount.pathIsMounted(target_path);
          // if not mounted, mount
          if (!result) {
            await mount.bindMount(normalized_staging_path, target_path, [
              "-o",
              bind_mount_flags.join(","),
            ]);
          } else {
            // if is mounted, ensure proper source
            if (access_type == "block") {
              normalized_staging_device = "dev"; // special syntax for single file bind mounts
            } else {
              normalized_staging_device = await mount.getMountPointDevice(
                staging_target_path
              );
            }
            result = await mount.deviceIsMountedAtPath(
              normalized_staging_device,
              target_path
            );
            if (!result) {
              throw new GrpcError(
                grpc.status.FAILED_PRECONDITION,
                `it appears something else is already mounted at ${target_path}`
              );
            }
          }

          return {};
        }

        // unsupported filesystem
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `only staged configurations are valid`
        );
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unknown/unsupported node_attach_driver: ${node_attach_driver}`
        );
    }

    return {};
  }

  async NodeUnpublishVolume(call) {
    const driver = this;
    const mount = new Mount();
    const filesystem = new Filesystem();
    let result;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const target_path = call.request.target_path;
    if (!target_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing target_path`);
    }
    const umount_args = [];
    const umount_force_extra_args = ["--force", "--lazy"];

    try {
      result = await mount.pathIsMounted(target_path);
    } catch (err) {
      // running findmnt on non-existant paths return immediately
      // the only time this should timeout is on a stale fs
      // so if timeout is hit we should be near certain it is indeed mounted
      if (err.timeout) {
        driver.ctx.logger.warn(
          `detected stale mount, attempting to force unmount: ${target_path}`
        );
        await mount.umount(
          target_path,
          umount_args.concat(umount_force_extra_args)
        );
        result = false; // assume we have fully unmounted
      } else {
        throw err;
      }
    }

    if (result) {
      try {
        result = await mount.umount(target_path, umount_args);
      } catch (err) {
        if (err.timeout) {
          driver.ctx.logger.warn(
            `hit timeout waiting to unmount path: ${target_path}`
          );
          // bind mounts do show the 'real' fs details
          result = await mount.getMountDetails(target_path);
          switch (result.fstype) {
            case "nfs":
            case "nfs4":
              driver.ctx.logger.warn(
                `detected stale nfs filesystem, attempting to force unmount: ${target_path}`
              );
              result = await mount.umount(
                target_path,
                umount_args.concat(umount_force_extra_args)
              );
              break;
            default:
              throw err;
              break;
          }
        } else {
          throw err;
        }
      }
    }

    result = await filesystem.pathExists(target_path);
    if (result) {
      if (fs.lstatSync(target_path).isDirectory()) {
        result = await filesystem.rmdir(target_path);
      } else {
        result = await filesystem.rm([target_path]);
      }
    }

    return {};
  }

  async NodeGetVolumeStats(call) {
    const driver = this;
    const mount = new Mount();
    const filesystem = new Filesystem();
    let result;
    let device_path;
    let access_type;
    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const volume_path = call.request.volume_path;
    const block_path = volume_path + "/block_device";

    if (!volume_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_path`);
    }

    let res = {};

    //VOLUME_CONDITION
    if (
      semver.satisfies(driver.ctx.csiVersion, ">=1.3.0") &&
      driver.options.service.node.capabilities.rpc.includes("VOLUME_CONDITION")
    ) {
      // TODO: let drivers fill ths in
      let abnormal = false;
      let message = "OK";
      res.volume_condition = { abnormal, message };
    }

    if (
      (await mount.isBindMountedBlockDevice(volume_path)) ||
      (await mount.isBindMountedBlockDevice(block_path))
    ) {
      device_path = block_path;
      access_type = "block";
    } else {
      device_path = volume_path;
      access_type = "mount";
    }

    switch (access_type) {
      case "mount":
        if (!(await mount.pathIsMounted(device_path))) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `nothing mounted at path: ${device_path}`
          );
        }
        result = await mount.getMountDetails(device_path, [
          "avail",
          "size",
          "used",
        ]);

        res.usage = [
          {
            available: result.avail,
            total: result.size,
            used: result.used,
            unit: "BYTES",
          },
        ];
        break;
      case "block":
        if (!(await filesystem.pathExists(device_path))) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `nothing mounted at path: ${device_path}`
          );
        }
        result = await filesystem.getBlockDevice(device_path);

        res.usage = [
          {
            total: result.size,
            unit: "BYTES",
          },
        ];
        break;
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unsupported/unknown access_type ${access_type}`
        );
    }

    return res;
  }

  /**
   * https://kubernetes-csi.github.io/docs/volume-expansion.html
   * allowVolumeExpansion: true
   * --feature-gates=ExpandCSIVolumes=true
   * --feature-gates=ExpandInUsePersistentVolumes=true
   *
   * @param {*} call
   */
  async NodeExpandVolume(call) {
    const mount = new Mount();
    const filesystem = new Filesystem();
    let device;
    let fs_info;
    let device_path;
    let access_type;
    let is_block = false;
    let is_formatted;
    let fs_type;
    let is_device_mapper = false;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const volume_path = call.request.volume_path;
    if (!volume_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_path`);
    }
    const block_path = volume_path + "/block_device";
    const capacity_range = call.request.capacity_range;
    const volume_capability = call.request.volume_capability;

    if (
      (await mount.isBindMountedBlockDevice(volume_path)) ||
      (await mount.isBindMountedBlockDevice(block_path))
    ) {
      access_type = "block";
      device_path = block_path;
    } else {
      access_type = "mount";
      device_path = volume_path;
    }

    try {
      device = await mount.getMountPointDevice(device_path);
      is_formatted = await filesystem.deviceIsFormatted(device);
      is_block = await filesystem.isBlockDevice(device);
    } catch (err) {
      if (err.code == 1) {
        throw new GrpcError(
          grpc.status.NOT_FOUND,
          `volume_path ${volume_path} is not currently mounted`
        );
      }
    }

    if (is_block) {
      let rescan_devices = [];
      // detect if is a multipath device
      is_device_mapper = await filesystem.isDeviceMapperDevice(device);
      if (is_device_mapper) {
        // NOTE: want to make sure we scan the dm device *after* all the underlying slaves
        rescan_devices = await filesystem.getDeviceMapperDeviceSlaves(device);
      }

      rescan_devices.push(device);

      for (let sdevice of rescan_devices) {
        // TODO: technically rescan is only relevant/available for remote drives
        // such as iscsi etc, should probably limit this call as appropriate
        // for now crudely checking the scenario inside the method itself
        await filesystem.rescanDevice(sdevice);
      }

      // let things settle
      // it appears the dm devices can take a second to figure things out
      if (is_device_mapper || true) {
        await sleep(2000);
      }

      if (is_formatted && access_type == "mount") {
        fs_info = await filesystem.getDeviceFilesystemInfo(device);
        fs_type = fs_info.type;
        if (fs_type) {
          switch (fs_type) {
            case "ext4":
            case "ext3":
            case "ext4dev":
              //await filesystem.checkFilesystem(device, fs_info.type);
              await filesystem.expandFilesystem(device, fs_type);
              break;
            case "xfs":
              let mount_info = await mount.getMountDetails(device_path);
              if (mount_info.fstype == "xfs") {
                //await filesystem.checkFilesystem(device, fs_info.type);
                await filesystem.expandFilesystem(device_path, fs_type);
              }
              break;
            default:
              // unsupported filesystem
              throw new GrpcError(
                grpc.status.FAILED_PRECONDITION,
                `unsupported/unknown filesystem ${fs_type}`
              );
          }
        }
      } else {
        //block device unformatted
        return {};
      }
    } else {
      // not block device
      return {};
    }

    return {};
  }
}
module.exports.CsiBaseDriver = CsiBaseDriver;
