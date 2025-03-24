const _ = require("lodash");
const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const GeneralUtils = require("../../utils/general");
const { ObjectiveFS } = require("../../utils/objectivefs");
const semver = require("semver");
const uuidv4 = require("uuid").v4;

const __REGISTRY_NS__ = "ControllerZfsLocalDriver";
const MAX_VOLUME_NAME_LENGTH = 63;

class ControllerObjectiveFSDriver extends CsiBaseDriver {
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
        //"ONLINE",
        //"OFFLINE"
      ];
    }

    if (!("rpc" in options.service.controller.capabilities)) {
      this.ctx.logger.debug("setting default controller caps");

      options.service.controller.capabilities.rpc = [
        //"UNKNOWN",
        "CREATE_DELETE_VOLUME",
        //"PUBLISH_UNPUBLISH_VOLUME",
        "LIST_VOLUMES",
        //"GET_CAPACITY",
        //"CREATE_DELETE_SNAPSHOT",
        //"LIST_SNAPSHOTS",
        //"CLONE_VOLUME",
        //"PUBLISH_READONLY",
        //"EXPAND_VOLUME",
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        options.service.controller.capabilities.rpc
          .push
          //"VOLUME_CONDITION",
          //"GET_VOLUME"
          ();
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
        //"EXPAND_VOLUME"
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        //options.service.node.capabilities.rpc.push("VOLUME_CONDITION");
      }

      if (semver.satisfies(this.ctx.csiVersion, ">=1.5.0")) {
        options.service.node.capabilities.rpc.push("SINGLE_NODE_MULTI_WRITER");
        /**
         * This is for volumes that support a mount time gid such as smb or fat
         */
        //options.service.node.capabilities.rpc.push("VOLUME_MOUNT_GROUP");
      }
    }
  }

  async getObjectiveFSClient() {
    const driver = this;
    return this.ctx.registry.getAsync(
      `${__REGISTRY_NS__}:objectivefsclient`,
      async () => {
        const options = {};
        options.sudo = _.get(
          driver.options,
          "objectivefs.cli.sudoEnabled",
          false
        );

        options.pool = _.get(driver.options, "objectivefs.pool");

        return new ObjectiveFS({
          ...options,
          env: _.get(driver.options, "objectivefs.env", {}),
        });
      }
    );
  }

  /**
   *
   * @returns Array
   */
  getAccessModes(capability) {
    let access_modes = _.get(this.options, "csi.access_modes", null);
    if (access_modes !== null) {
      return access_modes;
    }

    access_modes = [
      "UNKNOWN",
      "SINGLE_NODE_WRITER",
      "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
      "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
      "SINGLE_NODE_READER_ONLY",
      "MULTI_NODE_READER_ONLY",
      "MULTI_NODE_SINGLE_WRITER",
      "MULTI_NODE_MULTI_WRITER",
    ];

    if (
      capability.access_type == "block" &&
      !access_modes.includes("MULTI_NODE_MULTI_WRITER")
    ) {
      access_modes.push("MULTI_NODE_MULTI_WRITER");
    }

    return access_modes;
  }

  getFsTypes() {
    return ["fuse.objectivefs", "objectivefs"];
  }

  assertCapabilities(capabilities, callContext) {
    const driver = this;
    callContext.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    let fs_types = driver.getFsTypes();
    const valid = capabilities.every((capability) => {
      if (capability.access_type != "mount") {
        message = `invalid access_type ${capability.access_type}`;
        return false;
      }

      if (
        capability.mount.fs_type &&
        !fs_types.includes(capability.mount.fs_type)
      ) {
        message = `invalid fs_type ${capability.mount.fs_type}`;
        return false;
      }

      if (
        !this.getAccessModes(capability).includes(capability.access_mode.mode)
      ) {
        message = `invalid access_mode, ${capability.access_mode.mode}`;
        return false;
      }

      return true;
    });

    return { valid, message };
  }

  async getVolumeStatus(entry) {
    const driver = this;
    const object_store = _.get(driver.options, "objectivefs.env.OBJECTSTORE");
    const volume_id = entry.NAME.replace(object_store, "").split("/")[1];

    if (!!!semver.satisfies(driver.ctx.csiVersion, ">=1.2.0")) {
      return;
    }

    let abnormal = false;
    let message = "OK";
    let volume_status = {};

    //LIST_VOLUMES_PUBLISHED_NODES
    if (
      semver.satisfies(driver.ctx.csiVersion, ">=1.2.0") &&
      driver.options.service.controller.capabilities.rpc.includes(
        "LIST_VOLUMES_PUBLISHED_NODES"
      )
    ) {
      // TODO: let drivers fill this in
      volume_status.published_node_ids = [];
    }

    //VOLUME_CONDITION
    if (
      semver.satisfies(driver.ctx.csiVersion, ">=1.3.0") &&
      driver.options.service.controller.capabilities.rpc.includes(
        "VOLUME_CONDITION"
      )
    ) {
      // TODO: let drivers fill ths in
      volume_condition = { abnormal, message };
      volume_status.volume_condition = volume_condition;
    }

    return volume_status;
  }

  async populateCsiVolumeFromData(entry) {
    const driver = this;
    const object_store = _.get(driver.options, "objectivefs.env.OBJECTSTORE");
    let filesystem = entry.NAME.replace(object_store, "");

    let volume_content_source;
    let volume_context = {
      provisioner_driver: driver.options.driver,
      node_attach_driver: "objectivefs",
      filesystem,
      object_store,
      "env.OBJECTSTORE": object_store,
    };

    if (driver.options.instance_id) {
      volume_context["provisioner_driver_instance_id"] =
        driver.options.instance_id;
    }
    let accessible_topology;

    let volume = {
      volume_id: filesystem.split("/")[1],
      capacity_bytes: 0,
      content_source: volume_content_source,
      volume_context,
      accessible_topology,
    };

    return volume;
  }

  /**
   * Ensure sane options are used etc
   * true = ready
   * false = not ready, but progressiong towards ready
   * throw error = faulty setup
   *
   * @param {*} call
   */
  async Probe(call) {
    const driver = this;
    const pool = _.get(driver.options, "objectivefs.pool");
    const object_store = _.get(driver.options, "objectivefs.env.OBJECTSTORE");

    if (driver.ctx.args.csiMode.includes("controller")) {
      if (!pool) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `objectivefs.pool not configured`
        );
      }

      if (!object_store) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `env.OBJECTSTORE not configured`
        );
      }

      return { ready: { value: true } };
    } else {
      return { ready: { value: true } };
    }
  }

  /**
   * Create an objectivefs filesystem as a new volume
   *
   * @param {*} call
   */
  async CreateVolume(call) {
    const driver = this;
    const ofsClient = await driver.getObjectiveFSClient();
    const pool = _.get(driver.options, "objectivefs.pool");
    const object_store = _.get(driver.options, "objectivefs.env.OBJECTSTORE");
    const parameters = call.request.parameters;

    if (!pool) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `objectivefs.pool not configured`
      );
    }

    if (!object_store) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `env.OBJECTSTORE not configured`
      );
    }

    const context_env = {};
    for (const key in parameters) {
      if (key.startsWith("env.")) {
        context_env[key] = parameters[key];
      }
    }
    context_env["env.OBJECTSTORE"] = object_store;

    // filesystem names are always lower-cased by ofs
    let volume_id = await driver.getVolumeIdFromCall(call);
    let volume_content_source = call.request.volume_content_source;
    volume_id = volume_id.toLowerCase();
    const filesystem = `${pool}/${volume_id}`;

    if (volume_id.length >= MAX_VOLUME_NAME_LENGTH) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `derived volume_id ${volume_id} is too long for objectivefs`
      );
    }

    if (
      call.request.volume_capabilities &&
      call.request.volume_capabilities.length > 0
    ) {
      const result = this.assertCapabilities(call.request.volume_capabilities, callContext);
      if (result.valid !== true) {
        throw new GrpcError(grpc.status.INVALID_ARGUMENT, result.message);
      }
    } else {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        "missing volume_capabilities"
      );
    }

    if (
      !call.request.capacity_range ||
      Object.keys(call.request.capacity_range).length === 0
    ) {
      call.request.capacity_range = {
        required_bytes: 1073741824, // meaningless
      };
    }

    if (
      call.request.capacity_range.required_bytes > 0 &&
      call.request.capacity_range.limit_bytes > 0 &&
      call.request.capacity_range.required_bytes >
        call.request.capacity_range.limit_bytes
    ) {
      throw new GrpcError(
        grpc.status.OUT_OF_RANGE,
        `required_bytes is greather than limit_bytes`
      );
    }

    let capacity_bytes =
      call.request.capacity_range.required_bytes ||
      call.request.capacity_range.limit_bytes;

    if (!capacity_bytes) {
      //should never happen, value must be set
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume capacity is required (either required_bytes or limit_bytes)`
      );
    }

    // ensure *actual* capacity is not greater than limit
    if (
      call.request.capacity_range.limit_bytes &&
      call.request.capacity_range.limit_bytes > 0 &&
      capacity_bytes > call.request.capacity_range.limit_bytes
    ) {
      throw new GrpcError(
        grpc.status.OUT_OF_RANGE,
        `required volume capacity is greater than limit`
      );
    }

    if (volume_content_source) {
      //should never happen, cannot clone with this driver
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `cloning is not enabled`
      );
    }

    await ofsClient.create({}, filesystem, ["-f"]);

    let volume_context = {
      provisioner_driver: driver.options.driver,
      node_attach_driver: "objectivefs",
      filesystem,
      ...context_env,
    };

    if (driver.options.instance_id) {
      volume_context["provisioner_driver_instance_id"] =
        driver.options.instance_id;
    }

    const res = {
      volume: {
        volume_id,
        //capacity_bytes: capacity_bytes, // kubernetes currently pukes if capacity is returned as 0
        capacity_bytes: 0,
        content_source: volume_content_source,
        volume_context,
      },
    };

    return res;
  }

  /**
   * Delete a volume
   *
   * Deleting a volume consists of the following steps:
   * 1. delete directory
   *
   * @param {*} call
   */
  async DeleteVolume(call) {
    const driver = this;
    const ofsClient = await driver.getObjectiveFSClient();
    const pool = _.get(driver.options, "objectivefs.pool");

    let volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    // deleteStrategy
    const delete_strategy = _.get(
      driver.options,
      "_private.csi.volume.deleteStrategy",
      ""
    );

    if (delete_strategy == "retain") {
      return {};
    }

    volume_id = volume_id.toLowerCase();
    const filesystem = `${pool}/${volume_id}`;
    await ofsClient.destroy({}, filesystem, []);

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ControllerExpandVolume(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   * TODO: consider volume_capabilities?
   *
   * @param {*} call
   */
  async GetCapacity(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * TODO: check capability to ensure not asking about block volumes
   *
   * @param {*} call
   */
  async ListVolumes(call) {
    const driver = this;
    const ofsClient = await driver.getObjectiveFSClient();
    const pool = _.get(driver.options, "objectivefs.pool");

    let entries = [];
    let entries_length = 0;
    let next_token;
    let uuid;
    let response;

    const max_entries = call.request.max_entries;
    const starting_token = call.request.starting_token;

    // get data from cache and return immediately
    if (starting_token) {
      let parts = starting_token.split(":");
      uuid = parts[0];
      let start_position = parseInt(parts[1]);
      let end_position;
      if (max_entries > 0) {
        end_position = start_position + max_entries;
      }
      entries = this.ctx.cache.get(`ListVolumes:result:${uuid}`);
      if (entries) {
        entries_length = entries.length;
        entries = entries.slice(start_position, end_position);
        if (max_entries > 0 && end_position > entries_length) {
          next_token = `${uuid}:${end_position}`;
        } else {
          next_token = null;
        }
        const data = {
          entries: entries,
          next_token: next_token,
        };

        return data;
      } else {
        throw new GrpcError(
          grpc.status.ABORTED,
          `invalid starting_token: ${starting_token}`
        );
      }
    }

    entries = [];
    const list_entries = await ofsClient.list({});
    for (const entry of list_entries) {
      if (entry.KIND != "ofs") {
        continue;
      }

      let volume = await driver.populateCsiVolumeFromData(entry);
      if (volume) {
        let status = await driver.getVolumeStatus(entry);
        entries.push({
          volume,
          status,
        });
      }
    }

    if (max_entries && entries.length > max_entries) {
      uuid = uuidv4();
      this.ctx.cache.set(`ListVolumes:result:${uuid}`, entries);
      next_token = `${uuid}:${max_entries}`;
      entries = entries.slice(0, max_entries);
    }

    const data = {
      entries: entries,
      next_token: next_token,
    };

    return data;
  }

  /**
   *
   * @param {*} call
   */
  async ListSnapshots(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async CreateSnapshot(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   * In addition, if clones have been created from a snapshot, then they must
   * be destroyed before the snapshot can be destroyed.
   *
   * @param {*} call
   */
  async DeleteSnapshot(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(call) {
    const driver = this;
    const ofsClient = await driver.getObjectiveFSClient();
    const pool = _.get(driver.options, "objectivefs.pool");

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }

    const filesystem = `${pool}/${volume_id}`;
    const entries = await ofsClient.list({}, filesystem);
    const exists = entries.some((entry) => {
      return entry.NAME.endsWith(filesystem) && entry.KIND == "ofs";
    });

    if (!exists) {
      throw new GrpcError(
        grpc.status.NOT_FOUND,
        `invalid volume_id: ${volume_id}`
      );
    }

    const capabilities = call.request.volume_capabilities;
    if (!capabilities || capabilities.length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capabilities`);
    }

    const result = this.assertCapabilities(call.request.volume_capabilities, callContext);

    if (result.valid !== true) {
      return { message: result.message };
    }

    return {
      confirmed: {
        volume_context: call.request.volume_context,
        volume_capabilities: call.request.volume_capabilities, // TODO: this is a bit crude, should return *ALL* capabilities, not just what was requested
        parameters: call.request.parameters,
      },
    };
  }
}

module.exports.ControllerObjectiveFSDriver = ControllerObjectiveFSDriver;
