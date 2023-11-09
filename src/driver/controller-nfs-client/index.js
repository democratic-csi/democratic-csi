const { ControllerClientCommonDriver } = require("../controller-client-common");

/**
 * Crude nfs-client driver which simply creates directories to be mounted
 * and uses rsync for cloning/snapshots
 */
class ControllerNfsClientDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    super(...arguments);
  }

  getConfigKey() {
    return "nfs";
  }

  getVolumeContext(volume_id) {
    const driver = this;
    const config_key = driver.getConfigKey();
    return {
      node_attach_driver: "nfs",
      server: this.options[config_key].shareHost,
      share: driver.getShareVolumePath(volume_id),
    };
  }

  getFsTypes() {
    return ["nfs"];
  }
}

module.exports.ControllerNfsClientDriver = ControllerNfsClientDriver;
