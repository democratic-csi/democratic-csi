const _ = require("lodash");
const fs = require("fs");
const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const Handlebars = require("handlebars");
const path = require("path");
const semver = require("semver");
const WindowsUtils = require("../../utils/windows").Windows;
const wutils = new WindowsUtils();

/**
 * https://github.com/kubernetes/enhancements/blob/master/keps/sig-storage/20190122-csi-inline-volumes.md
 * https://kubernetes-csi.github.io/docs/ephemeral-local-volumes.html
 *
 * Sample calls:
 *  - https://gcsweb.k8s.io/gcs/kubernetes-jenkins/pr-logs/pull/92387/pull-kubernetes-e2e-gce/1280784994997899264/artifacts/_sig-storage_CSI_Volumes/_Driver_csi-hostpath_/_Testpattern_inline_ephemeral_CSI_volume_ephemeral/should_create_read_write_inline_ephemeral_volume/
 *  - https://storage.googleapis.com/kubernetes-jenkins/pr-logs/pull/92387/pull-kubernetes-e2e-gce/1280784994997899264/artifacts/_sig-storage_CSI_Volumes/_Driver_csi-hostpath_/_Testpattern_inline_ephemeral_CSI_volume_ephemeral/should_create_read-only_inline_ephemeral_volume/csi-hostpathplugin-0-hostpath.log
 *
 * inline drivers are assumed to be mount only (no block support)
 * purposely there is no native support for size contraints
 *
 */
class EphemeralInlineVHDDriver extends CsiBaseDriver {
  constructor(ctx, options) {
    super(...arguments);

    options = options || {};
    options.service = options.service || {};
    options.service.identity = options.service.identity || {};
    options.service.controller = options.service.controller || {};
    options.service.node = options.service.node || {};

    options.service.identity.capabilities =
      options.service.identity.capabilities || {};

    options.service.controller.capabilities =
      options.service.controller.capabilities || {};

    options.service.node.capabilities = options.service.node.capabilities || {};

    if (!("service" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity service caps");

      options.service.identity.capabilities.service = [
        "UNKNOWN",
        //"CONTROLLER_SERVICE"
        //"VOLUME_ACCESSIBILITY_CONSTRAINTS"
      ];
    }

    if (!("volume_expansion" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity volume_expansion caps");

      options.service.identity.capabilities.volume_expansion = [
        "UNKNOWN",
        //"ONLINE",
        //"OFFLINE"
      ];
    }

    if (!("rpc" in options.service.controller.capabilities)) {
      this.ctx.logger.debug("setting default controller caps");

      options.service.controller.capabilities.rpc = [
        //"UNKNOWN",
        //"CREATE_DELETE_VOLUME",
        //"PUBLISH_UNPUBLISH_VOLUME",
        //"LIST_VOLUMES",
        //"GET_CAPACITY",
        //"CREATE_DELETE_SNAPSHOT",
        //"LIST_SNAPSHOTS",
        //"CLONE_VOLUME",
        //"PUBLISH_READONLY",
        //"EXPAND_VOLUME"
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        options.service.controller.capabilities.rpc
          .push
          //"VOLUME_CONDITION",
          //"GET_VOLUME"
          ();
      }

      if (semver.satisfies(this.ctx.csiVersion, ">=1.5.0")) {
        options.service.controller.capabilities.rpc
          .push
          //"SINGLE_NODE_MULTI_WRITER"
          ();
      }
    }

    if (!("rpc" in options.service.node.capabilities)) {
      this.ctx.logger.debug("setting default node caps");
      options.service.node.capabilities.rpc = [
        //"UNKNOWN",
        //"STAGE_UNSTAGE_VOLUME",
        "GET_VOLUME_STATS",
        //"EXPAND_VOLUME",
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        //options.service.node.capabilities.rpc.push("VOLUME_CONDITION");
      }

      if (semver.satisfies(this.ctx.csiVersion, ">=1.5.0")) {
        options.service.node.capabilities.rpc.push("SINGLE_NODE_MULTI_WRITER");
        /**
         * This is for volumes that support a mount time gid such as smb or fat
         */
        //options.service.node.capabilities.rpc.push("VOLUME_MOUNT_GROUP");
      }
    }
  }

  assertCapabilities(capabilities) {
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
    const valid = capabilities.every((capability) => {
      if (capability.access_type != "mount") {
        message = `invalid access_type ${capability.access_type}`;
        return false;
      }

      if (capability.mount.fs_type) {
        message = `invalid fs_type ${capability.mount.fs_type}`;
        return false;
      }

      if (
        capability.mount.mount_flags &&
        capability.mount.mount_flags.length > 0
      ) {
        message = `invalid mount_flags ${capability.mount.mount_flags}`;
        return false;
      }

      if (
        ![
          "UNKNOWN",
          "SINGLE_NODE_WRITER",
          "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
          "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
          "SINGLE_NODE_READER_ONLY",
        ].includes(capability.access_mode.mode)
      ) {
        message = `invalid access_mode, ${capability.access_mode.mode}`;
        return false;
      }

      return true;
    });

    return { valid, message };
  }

  async Probe(call) {
    if (process.platform != "win32") {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `vhd-ephemeral-inline is only available on the windows platform`
      );
    }

    return super.Probe(...arguments);
  }

  /**
   *
   * @param {*} call
   */
  async NodePublishVolume(call) {
    const driver = this;

    const volume_id = call.request.volume_id;
    const staging_target_path = call.request.staging_target_path || "";
    const target_path = call.request.target_path;
    const capability = call.request.volume_capability;
    const access_type = capability.access_type || "mount";
    const readonly = call.request.readonly;
    const volume_context = call.request.volume_context;

    let result;

    let vhdParentPath;
    Object.keys(volume_context).forEach(function (key) {
      switch (key) {
        case "vhd.parentPath":
          vhdParentPath = volume_context[key];
          break;
      }
    });

    if (!vhdParentPath) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `vhd.parentPath is required`
      );
    }

    if (!volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    if (!target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `target_path is required`
      );
    }

    if (capability) {
      const result = driver.assertCapabilities([capability]);

      if (result.valid !== true) {
        throw new GrpcError(grpc.status.INVALID_ARGUMENT, result.message);
      }
    }

    // sanity check the parent
    if (!fs.existsSync(vhdParentPath)) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `vhd.parentPath (${vhdParentPath}) file does not exist`
      );
    }

    // create publish directory
    // if (!fs.existsSync(target_path)) {
    //   await fs.mkdirSync(target_path, { recursive: true });
    // }

    // get child path name
    let vhdParentPathDir = path.dirname(vhdParentPath);
    let vhdChildDiskName = volume_id;
    if (driver.options.vhd.nameTemplate) {
      vhdChildDiskName = Handlebars.compile(driver.options.vhd.nameTemplate)({
        // parameters: call.request.parameters,
        volume_id,
      });
    }

    let vhdChildPath = `${vhdParentPathDir}${
      path.sep
    }${vhdChildDiskName}${path.extname(vhdParentPath)}`;

    // create vhd
    if (!fs.existsSync(vhdChildPath)) {
      await wutils.NewVHDDifferencing(vhdParentPath, vhdChildPath);
    }

    // mount vhd if needed
    let disks;
    disks = await wutils.GetDisksByLocation(vhdChildPath);
    if (disks.length == 0) {
      await wutils.MountVHD(vhdChildPath);
    }

    // ensure disk is mounted
    disks = await wutils.GetDisksByLocation(vhdChildPath);
    let disk = disks[0];
    if (!disk) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `failed to mount vhd ${vhdParentPath}`
      );
    }

    // ensure the disk is online
    if (disk.OperationalStatus != "Online") {
      await wutils.OnlineDisk(disk.DiskNumber);
    }

    // get partition
    let partition = await wutils.GetLastPartitionByDiskNumber(disk.DiskNumber);

    // get volume
    let volume = await wutils.GetVolumeByDiskNumberPartitionNumber(
      disk.DiskNumber,
      partition.PartitionNumber
    );

    if (!volume) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `failed to discover volume for vhd ${vhdParentPath}`
      );
    }

    result = await wutils.GetItem(target_path);
    if (!result) {
      fs.mkdirSync(target_path, {
        recursive: true,
        mode: "755",
      });
      result = await wutils.GetItem(target_path);
    }

    let targets = result.Target;
    if (!Array.isArray(targets)) {
      if (targets) {
        targets[targets];
      } else {
        targets = [];
      }
    }

    if (
      !targets.some((target) => {
        return volume.UniqueId.includes(target);
      })
    ) {
      await wutils.MountVolume(volume.UniqueId, target_path);
    }

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async NodeUnpublishVolume(call) {
    const driver = this;

    const volume_id = call.request.volume_id;
    const target_path = call.request.target_path;

    if (!volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    if (!target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `target_path is required`
      );
    }

    let result;

    result = await wutils.GetItem(target_path);
    if (result) {
      if (result.LinkType == "Junction") {
        let volumeId = (await wutils.GetRealTarget(target_path)) || "";
        if (volumeId) {
          // should only ever have 1
          let disks = await wutils.GetDisksByVolumeId(volumeId);
          for (const disk of disks) {
            if (disk.Location) {
              // unmount
              await wutils.DismountVHD(disk.Location);
              // remove the vhd
              fs.rmSync(disk.Location);
            }
          }
        }
      }
    }

    // remove publish folder
    await wutils.DeleteItem(target_path);

    return {};
  }

  /**
   * TODO: consider volume_capabilities?
   *
   * @param {*} call
   */
  async GetCapacity(call) {
    return { available_capacity: 0 };
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(call) {
    const driver = this;
    const result = this.assertCapabilities(call.request.volume_capabilities);

    if (result.valid !== true) {
      return { message: result.message };
    }

    return {
      confirmed: {
        volume_context: call.request.volume_context,
        volume_capabilities: call.request.volume_capabilities, // TODO: this is a bit crude, should return *ALL* capabilities, not just what was requested
        parameters: call.request.parameters,
      },
    };
  }
}

module.exports.EphemeralInlineVHDDriver = EphemeralInlineVHDDriver;
