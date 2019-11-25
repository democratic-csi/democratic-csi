const { FreeNASDriver } = require("./freenas");

function factory(ctx, options) {
  switch (options.driver) {
    case "freenas-nfs":
    case "freenas-iscsi":
      return new FreeNASDriver(ctx, options);
    default:
      throw new Error("invalid csi driver: " + options.driver);
  }
}

module.exports.factory = factory;
