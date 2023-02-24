const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const semver = require("semver");

/**
 * Driver which only runs the node portion and is meant to be used entirely
 * with manually created PVs
 */
class NodeManualDriver extends CsiBaseDriver {
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
        //"UNKNOWN",
        //"CONTROLLER_SERVICE",
        //"VOLUME_ACCESSIBILITY_CONSTRAINTS"
      ];
    }

    if (!("volume_expansion" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity volume_expansion caps");

      options.service.identity.capabilities.volume_expansion = [
        //"UNKNOWN",
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
        //"EXPAND_VOLUME",
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
        "STAGE_UNSTAGE_VOLUME",
        "GET_VOLUME_STATS",
        //"EXPAND_VOLUME"
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

  assertCapabilities(capabilities, node_attach_driver) {
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    let driverResourceType;
    let fs_types = [];
    let access_modes = [];
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
    switch (node_attach_driver) {
      case "nfs":
        driverResourceType = "filesystem";
        fs_types = ["nfs"];
        break;
      case "smb":
        driverResourceType = "filesystem";
        fs_types = ["cifs"];
        break;
      case "lustre":
        driverResourceType = "filesystem";
        fs_types = ["lustre"];
        break;
      case "oneclient":
        driverResourceType = "filesystem";
        fs_types = ["oneclient", "fuse.oneclient"];
        break;
      case "hostpath":
        driverResourceType = "filesystem";
        break;
      case "iscsi":
      case "nvmeof":
        driverResourceType = "volume";
        fs_types = ["btrfs", "ext3", "ext4", "ext4dev", "xfs"];
        break;
      case "zfs-local":
        driverResourceType = "volume";
        fs_types = ["btrfs", "ext3", "ext4", "ext4dev", "xfs", "zfs"];
        access_modes = [
          "UNKNOWN",
          "SINGLE_NODE_WRITER",
          "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
          "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
          "SINGLE_NODE_READER_ONLY",
        ];
      default:
        return {
          valid: false,
          message: `unknown node_attach_driver: ${node_attach_driver}`,
        };
    }

    const valid = capabilities.every((capability) => {
      switch (driverResourceType) {
        case "filesystem":
          if (access_modes.length == 0) {
            access_modes = [
              "UNKNOWN",
              "SINGLE_NODE_WRITER",
              "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
              "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
              "SINGLE_NODE_READER_ONLY",
              "MULTI_NODE_READER_ONLY",
              "MULTI_NODE_SINGLE_WRITER",
              "MULTI_NODE_MULTI_WRITER",
            ];
          }
          if (capability.access_type != "mount") {
            message = `invalid access_type ${capability.access_type}`;
            return false;
          }

          if (
            capability.mount.fs_type &&
            !fs_types.includes(capability.mount.fs_type)
          ) {
            message = `invalid fs_type ${capability.mount.fs_type}`;
            return false;
          }

          if (!access_modes.includes(capability.access_mode.mode)) {
            message = `invalid access_mode, ${capability.access_mode.mode}`;
            return false;
          }

          return true;
        case "volume":
          if (access_modes.length == 0) {
            access_modes = [
              "UNKNOWN",
              "SINGLE_NODE_WRITER",
              "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
              "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
              "SINGLE_NODE_READER_ONLY",
              "MULTI_NODE_READER_ONLY",
              "MULTI_NODE_SINGLE_WRITER",
            ];
          }
          if (capability.access_type == "mount") {
            if (
              capability.mount.fs_type &&
              !fs_types.includes(capability.mount.fs_type)
            ) {
              message = `invalid fs_type ${capability.mount.fs_type}`;
              return false;
            }
          }

          if (!access_modes.includes(capability.access_mode.mode)) {
            message = `invalid access_mode, ${capability.access_mode.mode}`;
            return false;
          }

          return true;
      }
    });

    return { valid, message };
  }

  /**
   *
   * @param {*} call
   */
  async CreateVolume(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async DeleteVolume(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async ControllerExpandVolume(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async GetCapacity(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async ListVolumes(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async ListSnapshots(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async CreateSnapshot(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async DeleteSnapshot(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }
}

module.exports.NodeManualDriver = NodeManualDriver;
