const { FreeNASDriver } = require("./freenas");
const { ControllerZfsGenericDriver } = require("./controller-zfs-generic");

function factory(ctx, options) {
  switch (options.driver) {
    case "freenas-nfs":
    case "freenas-iscsi":
      return new FreeNASDriver(ctx, options);
    case "zfs-generic-nfs":
    case "zfs-generic-iscsi":
      return new ControllerZfsGenericDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
