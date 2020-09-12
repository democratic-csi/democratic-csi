const os = require("os");
const fs = require("fs");
const { GrpcError, grpc } = require("../utils/grpc");
const { Mount } = require("../utils/mount");
const { Filesystem } = require("../utils/filesystem");
const { ISCSI } = require("../utils/iscsi");
const sleep = require("../utils/general").sleep;

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
    this.options = options;
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
    const mount = new Mount();
    const filesystem = new Filesystem();
    const iscsi = new ISCSI();
    let result;
    let device;

    const volume_id = call.request.volume_id;
    const staging_target_path = call.request.staging_target_path;
    const capability = call.request.volume_capability;
    const access_type = capability.access_type || "mount";
    const volume_context = call.request.volume_context;
    let fs_type;
    let mount_flags;
    const node_attach_driver = volume_context.node_attach_driver;
    const block_path = staging_target_path + "/block_device";
    const bind_mount_flags = [];
    bind_mount_flags.push("defaults");

    const normalizedSecrets = this.getNormalizedParameters(
      call.request.secrets,
      call.request.volume_context.provisioner_driver,
      call.request.volume_context.provisioner_driver_instance_id
    );

    if (access_type == "mount") {
      fs_type = capability.mount.fs_type;
      mount_flags = capability.mount.mount_flags || [];
      // add secrets mount_flags
      if (normalizedSecrets.mount_flags) {
        mount_flags.push(normalizedSecrets.mount_flags);
      }
      mount_flags.push("defaults");
    }

    result = await this.assertCapabilities([capability]);
    if (!result.valid) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `invalid capability: ${result.message}`
      );
    }

    // csi spec stipulates that staging_target_path is a directory even for block mounts
    result = await filesystem.pathExists(staging_target_path);
    if (!result) {
      await filesystem.mkdir(staging_target_path, ["-p", "-m", "0750"]);
    }

    switch (node_attach_driver) {
      case "nfs":
        device = `${volume_context.server}:${volume_context.share}`;
        break;
      case "smb":
        device = `//${volume_context.server}/${volume_context.share}`;
        break;
      case "iscsi":
        // create DB entry
        // https://library.netapp.com/ecmdocs/ECMP1654943/html/GUID-8EC685B4-8CB6-40D8-A8D5-031A3899BCDC.html
        // put these options in place to force targets managed by csi to be explicitly attached (in the case of unclearn shutdown etc)
        let nodeDB = {
          "node.startup": "manual",
        };
        const nodeDBKeyPrefix = "node-db.";
        for (const key in normalizedSecrets) {
          if (key.startsWith(nodeDBKeyPrefix)) {
            nodeDB[key.substr(nodeDBKeyPrefix.length)] = normalizedSecrets[key];
          }
        }
        await iscsi.iscsiadm.createNodeDBEntry(
          volume_context.iqn,
          volume_context.portal,
          nodeDB
        );
        // login
        await iscsi.iscsiadm.login(volume_context.iqn, volume_context.portal);

        // find device name
        device = `/dev/disk/by-path/ip-${volume_context.portal}-iscsi-${volume_context.iqn}-lun-${volume_context.lun}`;

        // can take some time for device to show up, loop for some period
        result = await filesystem.pathExists(device);
        let timer_start = Math.round(new Date().getTime() / 1000);
        let timer_max = 30;
        while (!result) {
          await sleep(2000);
          result = await filesystem.pathExists(device);
          let current_time = Math.round(new Date().getTime() / 1000);
          if (!result && current_time - timer_start > timer_max) {
            throw new GrpcError(
              grpc.status.UNKNOWN,
              `hit timeout waiting for device node to appear: ${device}`
            );
          }
        }

        device = await filesystem.realpath(device);
        break;
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unknown/unsupported node_attach_driver: ${node_attach_driver}`
        );
    }

    switch (access_type) {
      case "mount":
        switch (node_attach_driver) {
          // block specific logic
          case "iscsi":
            if (await filesystem.isBlockDevice(device)) {
              // format
              result = await filesystem.deviceIsFormatted(device);
              if (!result) {
                await filesystem.formatDevice(device, fs_type);
              }

              let fs_info = await filesystem.getDeviceFilesystemInfo(device);
              fs_type = fs_info.type;

              // fsck
              result = await mount.deviceIsMountedAtPath(
                device,
                staging_target_path
              );
              if (!result) {
                await filesystem.checkFilesystem(device, fs_type);
              }
            }
            break;
          default:
            break;
        }

        result = await mount.deviceIsMountedAtPath(device, staging_target_path);
        if (!result) {
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
              await filesystem.expandFilesystem(device, fs_type);
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
    const mount = new Mount();
    const filesystem = new Filesystem();
    const iscsi = new ISCSI();
    let result;
    let is_block = false;
    let block_device_info;
    let access_type = "mount";

    const volume_id = call.request.volume_id;
    const staging_target_path = call.request.staging_target_path;
    const block_path = staging_target_path + "/block_device";
    let normalized_staging_path = staging_target_path;

    if (!staging_target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `missing staging_target_path`
      );
    }

    //result = await mount.pathIsMounted(block_path);
    //result = await mount.pathIsMounted(staging_target_path)

    result = await mount.pathIsMounted(block_path);
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
      result = await mount.umount(normalized_staging_path, ["--force"]);
    }

    if (is_block) {
      if (block_device_info.tran == "iscsi") {
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
            is_attached_to_session = session.attached_scsi_devices.host.devices.some(
              (device) => {
                if (device.attached_scsi_disk == block_device_info.name) {
                  return true;
                }
                return false;
              }
            );
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
    const mount = new Mount();
    const filesystem = new Filesystem();
    let result;

    const volume_id = call.request.volume_id;
    const staging_target_path = call.request.staging_target_path || "";
    const target_path = call.request.target_path;
    const capability = call.request.volume_capability;
    const access_type = capability.access_type || "mount";
    const readonly = call.request.readonly;
    const volume_context = call.request.volume_context;
    const bind_mount_flags = [];
    const node_attach_driver = volume_context.node_attach_driver;

    if (access_type == "mount") {
      let mount_flags = capability.mount.mount_flags || [];
      bind_mount_flags.push(...mount_flags);
    }

    bind_mount_flags.push("defaults");
    if (readonly) bind_mount_flags.push("ro");

    switch (node_attach_driver) {
      case "nfs":
      case "smb":
      case "iscsi":
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
    const mount = new Mount();
    const filesystem = new Filesystem();
    let result;

    const volume_id = call.request.volume_id;
    const target_path = call.request.target_path;

    result = await mount.pathIsMounted(target_path);
    if (result) {
      result = await mount.umount(target_path, ["--force"]);
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
    const mount = new Mount();
    const filesystem = new Filesystem();
    let result;
    let device_path;
    let access_type;
    const volume_id = call.request.volume_id;
    const volume_path = call.request.volume_path;
    const block_path = volume_path + "/block_device";

    if (!volume_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_path`);
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
        result = await mount.getMountDetails(device_path);

        return {
          usage: [
            {
              available: result.avail,
              total: result.size,
              used: result.used,
              unit: "BYTES",
            },
          ],
        };
      case "block":
        result = await filesystem.getBlockDevice(device_path);

        return {
          usage: [
            {
              total: result.size,
              unit: "BYTES",
            },
          ],
        };
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unsupported/unknown access_type ${access_type}`
        );
    }
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

    const volume_id = call.request.volume_id;
    const volume_path = call.request.volume_path;
    const block_path = volume_path + "/block_device";
    const capacity_range = call.request.capacity_range;
    const volume_capability = call.request.volume_capability;

    if (!volume_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_path`);
    }

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
          grpc.status.FAILED_PRECONDITION,
          `volume_path ${volume_path} is not currently mounted`
        );
      }
    }

    if (is_block) {
      await filesystem.rescanDevice(device);
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
