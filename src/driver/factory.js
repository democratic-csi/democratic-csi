const { FreeNASDriver } = require("./freenas");
const { ControllerZfsGenericDriver } = require("./controller-zfs-generic");
const {
  ZfsLocalEphemeralInlineDriver,
} = require("./zfs-local-ephemeral-inline");

function factory(ctx, options) {
  switch (options.driver) {
    case "freenas-nfs":
    case "freenas-iscsi":
    case "truenas-nfs":
    case "truenas-iscsi":
      return new FreeNASDriver(ctx, options);
    case "zfs-generic-nfs":
    case "zfs-generic-iscsi":
      return new ControllerZfsGenericDriver(ctx, options);
    case "zfs-local-ephemeral-inline":
      return new ZfsLocalEphemeralInlineDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
