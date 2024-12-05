const _ = require("lodash");
const semver = require("semver");
const { CsiBaseDriver } = require("../index");
const yaml = require("js-yaml");

// Some drivers will not work properly
// zfs-local-ephemeral-inline is not supported
// - NodePublishVolume needs this.options
// - - Possible fix: Add whole config to node publish secret
// - NodeUnpublishVolume does not have context to get driver
// - - Possible fix: ???
// zfs-local-* is not supported
// - NodeGetInfo does not have context to get driver
// - - Possible fix: move NodeGetInfo into CsiBaseDriver
// local-hostpath is not supported
// - NodeGetInfo does not have context to get driver
// - - Possible fix: move NodeGetInfo into CsiBaseDriver
// objectivefs is not supported
// - NodeStageVolume needs this.options in getDefaultObjectiveFSInstance, used only in NodeStageVolume
// - - Possible fix: store objectivefs pool data in volume attributes
// - - Possible fix: Add whole config to node stage secret
//
// There are some missing features:
// - GetCapacity is not possible, there is no concept of unified storage for proxy
// - ListVolumes is not possible, there is no concept of unified storage for proxy
// - ControllerGetVolume is not possible without k8s access for more context
//
// Volume cloning and snapshots:
// Works when both volumes have the same
// - remote server
// - parent dataset
// - type of volume
// volume_content_source field doesn't have anything except volume_id / snapshot_id
// so it doesn't seem possible to even know that something doesn't match.
// Even transfer between parent datasets on the same server would be difficult:
// maybe you could be able to scan all volumes (and/or snapshots) on the system
// for some custom dataset properties but it doesn't seem practical.
//
// Things could get better if volume_id somehow identified the server and the dataset.
// Naive way: make it server.address/full/dataset/path
// Server will then need to get access to server.address via some global config instead of using storage class secrets
// It would require significant changes to how application settings are handled.
//
// TODO support VOLUME_MOUNT_GROUP for SMB?
class CsiProxyDriver extends CsiBaseDriver {
  constructor(ctx, options) {
    super(...arguments);
    options = options || {};
    options.service = options.service || {};
    options.service.identity = options.service.identity || {};
    options.service.controller = options.service.controller || {};
    options.service.node = options.service.node || {};

    options.service.identity.capabilities =
      options.service.identity.capabilities || {};

    options.service.controller.capabilities =
      options.service.controller.capabilities || {};

    options.service.node.capabilities = options.service.node.capabilities || {};

    if (!("service" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity service caps");

      options.service.identity.capabilities.service = [
        //"UNKNOWN",
        "CONTROLLER_SERVICE",
        //"VOLUME_ACCESSIBILITY_CONSTRAINTS"
      ];
    }

    if (!("volume_expansion" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity volume_expansion caps");

      options.service.identity.capabilities.volume_expansion = [
        //"UNKNOWN",
        "ONLINE",
        //"OFFLINE"
      ];
    }

    if (!("rpc" in options.service.controller.capabilities)) {
      this.ctx.logger.debug("setting default controller caps");

      options.service.controller.capabilities.rpc = [
        //"UNKNOWN",
        "CREATE_DELETE_VOLUME",
        //"PUBLISH_UNPUBLISH_VOLUME",
        //"LIST_VOLUMES_PUBLISHED_NODES",
        // "LIST_VOLUMES",
        // "GET_CAPACITY",
        "CREATE_DELETE_SNAPSHOT",
        "LIST_SNAPSHOTS",
        "CLONE_VOLUME",
        //"PUBLISH_READONLY",
        "EXPAND_VOLUME",
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        options.service.controller.capabilities.rpc.push(
          //"VOLUME_CONDITION",
          // "GET_VOLUME"
        );
      }

      if (semver.satisfies(this.ctx.csiVersion, ">=1.5.0")) {
        options.service.controller.capabilities.rpc.push(
          "SINGLE_NODE_MULTI_WRITER"
        );
      }
    }

    if (!("rpc" in options.service.node.capabilities)) {
      this.ctx.logger.debug("setting default node caps");
      options.service.node.capabilities.rpc = [
        //"UNKNOWN",
        "STAGE_UNSTAGE_VOLUME",
        "GET_VOLUME_STATS",
        "EXPAND_VOLUME",
        //"VOLUME_CONDITION",
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        //options.service.node.capabilities.rpc.push("VOLUME_CONDITION");
      }

      if (semver.satisfies(this.ctx.csiVersion, ">=1.5.0")) {
        options.service.node.capabilities.rpc.push("SINGLE_NODE_MULTI_WRITER");
        /**
         * This is for volumes that support a mount time gid such as smb or fat
         */
        //options.service.node.capabilities.rpc.push("VOLUME_MOUNT_GROUP"); // in k8s is sent in as the security context fsgroup
      }
    }
  }

  getOptionsFromSecrets(call) {
    const prefix = "config-";
    let names = Object.keys(call.request.secrets).sort();
    let res = null;
    for (const i in names) {
      const key = names[i];
      // for some reason, call.request.secrets has an entry with typeof key == function
      if (typeof key !== 'string' || !key.startsWith(prefix)) {
        continue;
      }
      const secret = call.request.secrets[key];
      try {
        res = _.merge(res, yaml.load(secret));
      } catch (e) {
        console.log("failed parsing secret " + key, e);
        throw e;
      }
    }
    return res;
  }

  mergeOptions(call) {
    const options = this.getOptionsFromSecrets(call);
    const mergedOptions = structuredClone(this.options);
    _.merge(mergedOptions, options);
    if (!mergedOptions.driver) {
      throw "real driver is missing from config";
    }
    return mergedOptions;
  }

  validateDriver(driver) {
    const unsupportedDrivers = [
      "zfs-local-ephemeral-inline",
      "zfs-local-dataset",
      "zfs-local-zvol",
      "local-hostpath",
      "objectivefs",
    ];
    if (unsupportedDrivers.includes(driver)) {
      throw "proxy is not supported for driver: " + mergedOptions.driver;
    }
  }

  createDriverFromSecrets(call) {
    const driverOptions = this.mergeOptions(call)
    this.validateDriver(driverOptions.driver);
    const realDriver = this.ctx.factory(this.ctx, driverOptions);
    if (realDriver.constructor.name == this.constructor.name) {
      throw "cyclic dependency: proxy on proxy";
    }
    this.ctx.logger.debug("using driver %s", realDriver.constructor.name);
    return realDriver;
  }

  createDriverFromVolumeContext(call) {
    const driverOptions = structuredClone(this.options);
    driverOptions.driver = call.request.volume_context.provisioner_driver;
    this.validateDriver(driverOptions.driver);
    const realDriver = this.ctx.factory(this.ctx, driverOptions);
    if (realDriver.constructor.name == this.constructor.name) {
      throw "cyclic dependency: proxy on proxy";
    }
    return realDriver;
  }

  async CreateVolume(call) {
    return this.createDriverFromSecrets(call).CreateVolume(call);
  }

  async DeleteVolume(call) {
    return this.createDriverFromSecrets(call).DeleteVolume(call);
  }

  async ControllerExpandVolume(call) {
    return this.createDriverFromSecrets(call).ControllerExpandVolume(call);
  }

  async ListSnapshots(call) {
    return this.createDriverFromSecrets(call).ListSnapshots(call);
  }

  async CreateSnapshot(call) {
    return this.createDriverFromSecrets(call).CreateSnapshot(call);
  }

  async DeleteSnapshot(call) {
    return this.createDriverFromSecrets(call).DeleteSnapshot(call);
  }

  async ValidateVolumeCapabilities(call) {
    return this.createDriverFromSecrets(call).ValidateVolumeCapabilities(call);
  }

  async NodeStageVolume(call) {
    return this.createDriverFromVolumeContext(call).NodeStageVolume(call);
  }

  async NodePublishVolumeRequest(call) {
    return this.createDriverFromVolumeContext(call).NodePublishVolumeRequest(call);
  }
}

module.exports.CsiProxyDriver = CsiProxyDriver;
