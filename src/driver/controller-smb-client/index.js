const { ControllerClientCommonDriver } = require("../controller-client-common");

/**
 * Crude smb-client driver which simply creates directories to be mounted
 * and uses rsync for cloning/snapshots
 */
class ControllerSmbClientDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    super(...arguments);
  }

  getConfigKey() {
    return "smb";
  }

  getVolumeContext(name) {
    const driver = this;
    const config_key = driver.getConfigKey();
    return {
      node_attach_driver: "smb",
      server: this.options[config_key].shareHost,
      share: driver.stripLeadingSlash(driver.getShareVolumePath(name)),
    };
  }

  getFsTypes() {
    return ["cifs"];
  }
}

module.exports.ControllerSmbClientDriver = ControllerSmbClientDriver;
