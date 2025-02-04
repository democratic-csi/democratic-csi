const _ = require("lodash");
const semver = require("semver");
const { CsiBaseDriver } = require("../index");
const yaml = require("js-yaml");
const fs = require('fs');
const { Registry } = require("../../utils/registry");

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
// - ListSnapshots is not possible, there is no concept of unified storage for proxy
// - - Possible to fix for requests with source_volume_id or snapshot_id
//
// Volume cloning and snapshots:
// volume_content_source field doesn't have anything except volume_id / snapshot_id
// Cloning works when both volumes use the same connection.
// If the connection is different:
// - Same driver, same server
// - - Just need to get proper source location in the CreateVolume
// - Same driver, different servers
// - - It's up to driver to add support
// - - Example: zfs send-receive
// - - Example: file copy between nfs servers
// - Different drivers: block <-> file: will never be possible
// - Different drivers: same filesystem type
// - - Drivers should implement generic export and import functions
// - - For example: truenas -> generic-zfs should theoretically be possible via zfs send
// - - For example: nfs -> nfs should theoretically be possible via file copy
// - - How to coordinate different drivers?
//
// TODO support VOLUME_MOUNT_GROUP for SMB?

// volume_id format:   v2:server-entry/original-handle
// snapshot_id format: v2:server-entry/original-handle
// 'v2' - fixed prefix
// server-entry - name of the config file, without .yaml suffix
// volume-handle - original handle as expected by the real driver, valid only in context of this server-entry
//
class CsiProxy2Driver extends CsiBaseDriver {
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
        // "LIST_SNAPSHOTS",
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

  parseVolumeHandle(handle) {
    if (!handle.startsWith('v2:')) {
      throw 'invalid volume handle: ' + handle;
    }
    handle = handle.substring('v2:'.length);
    return {
      connectionName: handle.substring(0, handle.indexOf('/')),
      realHandle: handle.substring(handle.indexOf('/') + 1),
    };
  }

  decorateVolumeHandle(connectionName, handle) {
    return 'v2:' + connectionName + '/' + handle;
  }

  lookUpConnection(connectionName) {
    const configFolder = this.options.proxy.configFolder;
    const configPath = configFolder + '/' + connectionName + '.yaml';

    const cachedDriver = this.ctx.registry.get(`controller:driver/connection=${connectionName}`, () => {
      return {
        connectionName: connectionName,
        fileTime: this.getFileTime(configPath),
        driver: this.createDriverFromFile(configPath),
      };
    });
    const fileTime = this.getFileTime(configPath);
    if (cachedDriver.fileTime != fileTime) {
      cachedDriver.fileTime = cachedDriver.fileTime;
      cachedDriver.driver = this.createDriverFromFile(configPath);
    }
    return cachedDriver.driver;
  }

  getFileTime(path) {
    try {
      const configFileStats = fs.statSync(path);
      this.ctx.logger.debug("file time %s %v", path, configFileStats.mtime);
      return configFileStats.mtime;
    } catch (e) {
      this.ctx.logger.error("fs.statSync failed: %s", e.toString());
      throw e;
    }
  }

  createDriverFromFile(configPath) {
    const fileOptions = this.createOptionsFromFile(configPath);
    const mergedOptions = structuredClone(this.options);
    _.merge(mergedOptions, fileOptions);
    return this.createRealDriver(mergedOptions);
  }

  createOptionsFromFile(configPath) {
    this.ctx.logger.debug("loading config: %s", configPath);
    try {
      return yaml.load(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      this.ctx.logger.error("failed parsing config file: %s", e.toString());
      throw e;
    }
  }

  validateDriver(driver) {
    const unsupportedDrivers = [
      "zfs-local-",
      "local-hostpath",
      "objectivefs",
      "proxy",
    ];
    for (const prefix in unsupportedDrivers) {
      if (driver.startsWith(prefix)) {
        throw "proxy is not supported for driver: " + mergedOptions.driver;
      }
    }
  }

  createRealDriver(options) {
    this.validateDriver(options.driver);
    const realContext = Object.assign({}, this.ctx);
    realContext.registry = new Registry();
    const realDriver = this.ctx.factory(realContext, options);
    if (realDriver.constructor.name == this.constructor.name) {
      throw "cyclic dependency: proxy on proxy";
    }
    this.ctx.logger.debug("using driver %s", realDriver.constructor.name);
    return realDriver;
  }

  async CreateVolume(call) {
    const parameters = call.request.parameters;
    if (!parameters.connection) {
      throw 'connection missing from parameters';
    }
    const connectionName = parameters.connection;

    if (call.request.volume_content_source) {
      switch (call.request.volume_content_source.type) {
        case "snapshot": {
          const snapshotHandle = this.parseVolumeHandle(call.request.volume_content_source.snapshot.snapshot_id);
          if (snapshotHandle.connectionName != connectionName) {
            throw "could not inflate snapshot from a different connection";
          }
          call.request.volume_content_source.snapshot.snapshot_id = snapshotHandle.realHandle;
          break;
        }
        case "volume": {
          const volumeHandle = this.parseVolumeHandle(call.request.volume_content_source.volume.volume_id);
          if (volumeHandle.connectionName != connectionName) {
            throw "could not copy volume from a different connection";
          }
          call.request.volume_content_source.volume.volume_id = volumeHandle.realHandle;
          break;
        }
        default:
          throw 'unknown volume_content_source type: ' + call.request.volume_content_source.type;
      }
    }
    const driver = this.lookUpConnection(connectionName);
    const result = await driver.CreateVolume(call);
    this.ctx.logger.debug("CreateVolume result " + result);
    result.volume.volume_id = this.decorateVolumeHandle(connectionName, result.volume.volume_id);
    return result;
  }

  async DeleteVolume(call) {
    const volumeHandle = this.parseVolumeHandle(call.request.volume_id);
    const driver = this.lookUpConnection(volumeHandle.connectionName);
    call.request.volume_id = volumeHandle.realHandle;
    return driver.DeleteVolume(call);
  }

  async ControllerExpandVolume(call) {
    const volumeHandle = this.parseVolumeHandle(call.request.volume_id);
    const driver = this.lookUpConnection(volumeHandle.connectionName);
    call.request.volume_id = volumeHandle.realHandle;
    return driver.ControllerExpandVolume(call);
  }

  async CreateSnapshot(call) {
    const volumeHandle = this.parseVolumeHandle(call.request.source_volume_id);
    const driver = this.lookUpConnection(volumeHandle.connectionName);
    call.request.source_volume_id = volumeHandle.realHandle;
    const result = await driver.CreateSnapshot(call);
    result.snapshot.source_volume_id = volumeHandle;
    result.snapshot.snapshot_id = this.decorateVolumeHandle(connectionName, result.snapshot.snapshot_id);
    return result;
  }

  async DeleteSnapshot(call) {
    const volumeHandle = this.parseVolumeHandle(call.request.snapshot_id);
    const driver = this.lookUpConnection(volumeHandle.connectionName);
    call.request.snapshot_id = volumeHandle.realHandle;
    return driver.DeleteSnapshot(call);
  }

  async ValidateVolumeCapabilities(call) {
    const volumeHandle = this.parseVolumeHandle(call.request.volume_id);
    const driver = this.lookUpConnection(volumeHandle.connectionName);
    call.request.volume_id = volumeHandle.realHandle;
    return driver.ValidateVolumeCapabilities(call);
  }

  lookUpNodeDriver(call) {
    const driverName = call.request.volume_context.provisioner_driver;
    return this.ctx.registry.get(`node:driver/${driverName}`, () => {
      const driverOptions = structuredClone(this.options);
      driverOptions.driver = call.request.volume_context.provisioner_driver;
      return this.createRealDriver(driverOptions);
    });
  }

  // CsiBaseDriver.NodeStageVolume calls this.assertCapabilities which should be run in the real driver
  // but no other driver-specific functions are used,
  // so we can just create an empty driver with default options
  async NodeStageVolume(call) {
    return this.lookUpNodeDriver(call).NodeStageVolume(call);
  }

  // async NodePublishVolume(call) {
  //   return this.lookUpNodeDriver(call).NodePublishVolume(call);
  // }
}

module.exports.CsiProxy2Driver = CsiProxy2Driver;
