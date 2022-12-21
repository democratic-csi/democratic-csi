const { FreeNASSshDriver } = require("./freenas/ssh");
const { FreeNASApiDriver } = require("./freenas/api");
const {
  ControllerLocalHostpathDriver,
} = require("./controller-local-hostpath");
const { ControllerZfsGenericDriver } = require("./controller-zfs-generic");
const { ControllerZfsLocalDriver } = require("./controller-zfs-local");
const {
  ZfsLocalEphemeralInlineDriver,
} = require("./zfs-local-ephemeral-inline");

const { ControllerNfsClientDriver } = require("./controller-nfs-client");
const { ControllerSmbClientDriver } = require("./controller-smb-client");
const { ControllerLustreClientDriver } = require("./controller-lustre-client");
const { ControllerSynologyDriver } = require("./controller-synology");
const { NodeManualDriver } = require("./node-manual");

function factory(ctx, options) {
  switch (options.driver) {
    case "freenas-nfs":
    case "freenas-smb":
    case "freenas-iscsi":
    case "truenas-nfs":
    case "truenas-smb":
    case "truenas-iscsi":
      return new FreeNASSshDriver(ctx, options);
    case "freenas-api-iscsi":
    case "freenas-api-nfs":
    case "freenas-api-smb":
      return new FreeNASApiDriver(ctx, options);
    case "synology-nfs":
    case "synology-smb":
    case "synology-iscsi":
      return new ControllerSynologyDriver(ctx, options);
    case "zfs-generic-nfs":
    case "zfs-generic-smb":
    case "zfs-generic-iscsi":
    case "zfs-generic-nvmeof":
      return new ControllerZfsGenericDriver(ctx, options);
    case "zfs-local-dataset":
    case "zfs-local-zvol":
      return new ControllerZfsLocalDriver(ctx, options);
    case "zfs-local-ephemeral-inline":
      return new ZfsLocalEphemeralInlineDriver(ctx, options);
    case "smb-client":
      return new ControllerSmbClientDriver(ctx, options);
    case "nfs-client":
      return new ControllerNfsClientDriver(ctx, options);
    case "local-hostpath":
      return new ControllerLocalHostpathDriver(ctx, options);
    case "lustre-client":
      return new ControllerLustreClientDriver(ctx, options);
    case "node-manual":
      return new NodeManualDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
