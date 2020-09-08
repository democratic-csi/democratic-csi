const { FreeNASDriver } = require("./freenas");
const { ControllerZfsGenericDriver } = require("./controller-zfs-generic");
const {
  ZfsLocalEphemeralInlineDriver,
} = require("./zfs-local-ephemeral-inline");

const { ControllerNfsClientDriver } = require("./controller-nfs-client");

function factory(ctx, options) {
  switch (options.driver) {
    case "freenas-nfs":
    case "freenas-smb":
    case "freenas-iscsi":
    case "truenas-nfs":
    case "truenas-smb":
    case "truenas-iscsi":
      return new FreeNASDriver(ctx, options);
    case "zfs-generic-nfs":
    case "zfs-generic-iscsi":
      return new ControllerZfsGenericDriver(ctx, options);
    case "zfs-local-ephemeral-inline":
      return new ZfsLocalEphemeralInlineDriver(ctx, options);
    case "nfs-client":
      return new ControllerNfsClientDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
