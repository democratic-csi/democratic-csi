const { FreeNASDriver } = require("./freenas");
const { ControllerZfsGenericDriver } = require("./controller-zfs-generic");
const {
  ZfsLocalEphemeralInlineDriver,
} = require("./zfs-local-ephemeral-inline");

const { ControllerNfsClientDriver } = require("./controller-nfs-client");
const { ControllerSmbClientDriver } = require("./controller-smb-client");
const { NodeManualDriver } = require("./node-manual");

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
    case "smb-client":
      return new ControllerSmbClientDriver(ctx, options);
    case "nfs-client":
      return new ControllerNfsClientDriver(ctx, options);
    case "node-manual":
      return new NodeManualDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
