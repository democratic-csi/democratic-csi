const _ = require("lodash");

const { ControllerClientCommonDriver } = require("../controller-client-common");

const NODE_TOPOLOGY_KEY_NAME = "org.democratic-csi.topology/node";

/**
 * Crude local-hostpath driver which simply creates directories to be mounted
 * and uses rsync for cloning/snapshots
 */
class ControllerLocalHostpathDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    const i_caps = _.get(
      options,
      "service.identity.capabilities.service",
      false
    );

    const c_caps = _.get(options, "service.controller.capabilities", false);
    super(...arguments);

    if (!i_caps) {
      this.ctx.logger.debug("setting local-hostpath identity service caps");

      options.service.identity.capabilities.service = [
        //"UNKNOWN",
        "CONTROLLER_SERVICE",
        "VOLUME_ACCESSIBILITY_CONSTRAINTS",
      ];
    }

    if (!c_caps) {
      this.ctx.logger.debug("setting local-hostpath controller service caps");

      if (
        !options.service.controller.capabilities.rpc.includes("GET_CAPACITY")
      ) {
        options.service.controller.capabilities.rpc.push("GET_CAPACITY");
      }
    }
  }

  getConfigKey() {
    return "local-hostpath";
  }

  getVolumeContext(volume_id) {
    const driver = this;
    return {
      node_attach_driver: "hostpath",
      path: driver.getShareVolumePath(volume_id),
    };
  }

  getFsTypes() {
    return [];
  }

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
  async NodeGetInfo(callContext, call) {
    const response = await super.NodeGetInfo(...arguments);
    response.accessible_topology = {
      segments: {
        [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
      },
    };
    return response;
  }
}

module.exports.ControllerLocalHostpathDriver = ControllerLocalHostpathDriver;
