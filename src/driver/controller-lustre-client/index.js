const { ControllerClientCommonDriver } = require("../controller-client-common");

/**
 * Crude lustre-client driver which simply creates directories to be mounted
 * and uses rsync for cloning/snapshots
 */
class ControllerLustreClientDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    super(...arguments);
  }

  getConfigKey() {
    return "lustre";
  }

  getVolumeContext(name) {
    const driver = this;
    const config_key = driver.getConfigKey();
    return {
      node_attach_driver: "lustre",
      server: this.options[config_key].shareHost,
      share: driver.getShareVolumePath(name),
    };
  }

  getFsTypes() {
    return ["lustre"];
  }
}

module.exports.ControllerLustreClientDriver = ControllerLustreClientDriver;
