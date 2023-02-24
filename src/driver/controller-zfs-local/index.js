const _ = require("lodash");
const { ControllerZfsBaseDriver } = require("../controller-zfs");
const { GrpcError, grpc } = require("../../utils/grpc");
const GeneralUtils = require("../../utils/general");
const LocalCliExecClient =
  require("../../utils/zfs_local_exec_client").LocalCliClient;
const registry = require("../../utils/registry");
const { Zetabyte } = require("../../utils/zfs");

const ZFS_ASSET_NAME_PROPERTY_NAME = "zfs_asset_name";
const NODE_TOPOLOGY_KEY_NAME = "org.democratic-csi.topology/node";

const __REGISTRY_NS__ = "ControllerZfsLocalDriver";

class ControllerZfsLocalDriver extends ControllerZfsBaseDriver {
  constructor(ctx, options) {
    const i_caps = _.get(
      options,
      "service.identity.capabilities.service",
      false
    );
    super(...arguments);

    if (!i_caps) {
      this.ctx.logger.debug("setting zfs-local identity service caps");

      options.service.identity.capabilities.service = [
        //"UNKNOWN",
        "CONTROLLER_SERVICE",
        "VOLUME_ACCESSIBILITY_CONSTRAINTS",
      ];
    }
  }

  getExecClient() {
    return registry.get(`${__REGISTRY_NS__}:exec_client`, () => {
      return new LocalCliExecClient({
        logger: this.ctx.logger,
      });
    });
  }

  async getZetabyte() {
    return registry.getAsync(`${__REGISTRY_NS__}:zb`, async () => {
      const execClient = this.getExecClient();

      const options = {};
      options.executor = execClient;
      options.idempotent = true;

      /*
      if (
        this.options.zfs.hasOwnProperty("cli") &&
        this.options.zfs.cli &&
        this.options.zfs.cli.hasOwnProperty("paths")
      ) {
        options.paths = this.options.zfs.cli.paths;
      }
      */

      // use env based paths to allow for custom wrapper scripts to chroot to the host
      options.paths = {
        zfs: "zfs",
        zpool: "zpool",
        sudo: "sudo",
        chroot: "chroot",
      };

      options.sudo = _.get(this.options, "zfs.cli.sudoEnabled", false);

      if (typeof this.setZetabyteCustomOptions === "function") {
        await this.setZetabyteCustomOptions(options);
      }

      return new Zetabyte(options);
    });
  }

  /**
   * cannot make this a storage class parameter as storage class/etc context is *not* sent
   * into various calls such as GetControllerCapabilities etc
   */
  getDriverZfsResourceType() {
    switch (this.options.driver) {
      case "zfs-local-dataset":
        return "filesystem";
      case "zfs-local-zvol":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  getFSTypes() {
    const driverZfsResourceType = this.getDriverZfsResourceType();
    switch (driverZfsResourceType) {
      case "filesystem":
        return ["zfs"];
      case "volume":
        return GeneralUtils.default_supported_block_filesystems();
    }
  }

  /**
   * Although it is conter-intuitive to advertise node-local volumes as RWX we
   * do so here to provide an easy out-of-the-box experience as users will by
   * default want to provision volumes of RWX. The topology contraints
   * implicity will enforce only a single node can use the volume at a given
   * time.
   *
   * @returns Array
   */
  getAccessModes() {
    let access_modes = _.get(this.options, "csi.access_modes", null);
    if (access_modes !== null) {
      return access_modes;
    }

    const driverZfsResourceType = this.getDriverZfsResourceType();
    switch (driverZfsResourceType) {
      case "filesystem":
        return [
          "UNKNOWN",
          "SINGLE_NODE_WRITER",
          "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
          "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
          "SINGLE_NODE_READER_ONLY",
          "MULTI_NODE_READER_ONLY",
          "MULTI_NODE_SINGLE_WRITER",
          "MULTI_NODE_MULTI_WRITER",
        ];
      case "volume":
        return [
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
  }

  /**
   * csi controller service
   *
   * should create any necessary share resources and return volume context
   *
   * @param {*} datasetName
   */
  async createShare(call, datasetName) {
    let volume_context = {};

    switch (this.options.driver) {
      case "zfs-local-dataset":
        volume_context = {
          node_attach_driver: "zfs-local",
          [ZFS_ASSET_NAME_PROPERTY_NAME]: datasetName,
        };
        return volume_context;

      case "zfs-local-zvol":
        volume_context = {
          node_attach_driver: "zfs-local",
          [ZFS_ASSET_NAME_PROPERTY_NAME]: datasetName,
        };
        return volume_context;

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driver ${this.options.driver}`
        );
    }
  }

  /**
   * csi controller service
   *
   * @param {*} call
   * @param {*} datasetName
   * @returns
   */
  async deleteShare(call, datasetName) {
    return {};
  }

  /**
   * csi controller service
   *
   * @param {*} call
   * @param {*} datasetName
   */
  async expandVolume(call, datasetName) {}

  /**
   * List of topologies associated with the *volume*
   *
   * @returns array
   */
  async getAccessibleTopology() {
    const response = await super.NodeGetInfo(...arguments);
    return [
      {
        segments: {
          [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
        },
      },
    ];
  }

  /**
   * Add node topologies
   *
   * @param {*} call
   * @returns
   */
  async NodeGetInfo(call) {
    const response = await super.NodeGetInfo(...arguments);
    response.accessible_topology = {
      segments: {
        [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
      },
    };
    return response;
  }
}

module.exports.ControllerZfsLocalDriver = ControllerZfsLocalDriver;
