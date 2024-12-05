const _ = require("lodash");
const semver = require("semver");
const { CsiBaseDriver } = require("../index");
const yaml = require("js-yaml");

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
          "GET_VOLUME"
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

    // if (options.fallbackDriver) {
    //   const optionsClone = structuredClone(value);
    //   optionsClone.driver = options.fallbackDriver;
    //   this.fallbackDriver = ctx.factory(ctx, optionsClone);
    // }
  }

  getOptionsFromSecrets(call) {
    const prefix = "config-";
    let names = Object.keys(call.request.secrets).sort();
    let res = null;
    for (const i in names) {
      const key = names[i];
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

  createRealDriver(call) {
    const mergedOptions = this.mergeOptions(call)
    const realDriver = this.ctx.factory(this.ctx, mergedOptions);
    if (realDriver.constructor.name == this.constructor.name) {
      throw "cyclic dependency: proxy on proxy";
    }
    this.ctx.logger.debug("using driver %s", realDriver.constructor.name);
    return realDriver;
  }

  // async GetPluginInfo(call) {
  //   return super.GetPluginInfo(call);
  // }

  // async GetPluginCapabilities(call) {
  //   return super.GetPluginCapabilities(call);
  // }

  // async Probe(call) {
  //   return super.Probe(call);
  // }

  async CreateVolume(call) {
    return this.createRealDriver(call).CreateVolume(call);
  }

  async DeleteVolume(call) {
    return this.createRealDriver(call).DeleteVolume(call);
  }

  // async ControllerGetCapabilities(call) {
  //   return super.ControllerGetCapabilities();
  // }

  async ControllerExpandVolume(call) {
    return this.createRealDriver(call).ControllerExpandVolume(call);
  }

  // GetCapacityRequest does not have secrets
  // async GetCapacity(call) {
  //   return this.createDriver(call).GetCapacity(call);
  // }

  // ControllerGetVolumeRequest does not have secrets
  // async ControllerGetVolume(call) {
  //   return super.ControllerGetVolume();
  // }

  // ListVolumesRequest does not have secrets
  // async ListVolumes(call) {
  //   return super.ListVolumes();
  // }

  async ListSnapshots(call) {
    return this.createRealDriver(call).ListSnapshots(call);
  }

  async CreateSnapshot(call) {
    return this.createRealDriver(call).CreateSnapshot(call);
  }

  async DeleteSnapshot(call) {
    return this.createRealDriver(call).DeleteSnapshot(call);
  }

  async ValidateVolumeCapabilities(call) {
    return this.createRealDriver(call).ValidateVolumeCapabilities(call);
  }

  // async NodeGetCapabilities(call) {
  //   return super.NodeGetCapabilities(call);
  // }

  // TODO controller-zfs-local needs this
  // async NodeGetInfo(call) {
  //   return super.NodeGetInfo(call);
  // }

  async NodeStageVolume(call) {
    return this.createRealDriver(call).NodeStageVolume(call);
  }

  // NodeUnstageVolumeRequest does not have secrets
  // async NodeUnstageVolume(call) {
  //   return this.createRealDriver(call).NodeUnstageVolume(call);
  // }

  async NodePublishVolume(call) {
    return this.createRealDriver(call).NodePublishVolume(call);
  }

  // NodeUnpublishVolumeRequest does not have secrets
  // TODO zfs-local-ephemeral seems to use this
  // async NodeUnpublishVolume(call) {
  //   return this.createRealDriver(call).NodeUnpublishVolume(call);
  // }

  // NodeGetVolumeStatsRequest does not have secrets
  // async NodeGetVolumeStats(call) {
  //   return this.createDriver(call).NodeGetVolumeStats(call);
  // }

  // NodeExpandVolumeRequest has field for secrets but external-resizer does not populate it
  // async NodeExpandVolume(call) {
  //   return this.createRealDriver(call).NodeExpandVolume(call);
  // }
}

module.exports.CsiProxyDriver = CsiProxyDriver;
