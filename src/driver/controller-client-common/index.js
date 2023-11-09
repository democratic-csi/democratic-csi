const _ = require("lodash");
const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const cp = require("child_process");
const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const semver = require("semver");

/**
 * Crude nfs-client driver which simply creates directories to be mounted
 * and uses rsync for cloning/snapshots
 */
class ControllerClientCommonDriver extends CsiBaseDriver {
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
        //"LIST_VOLUMES",
        //"GET_CAPACITY",
        "CREATE_DELETE_SNAPSHOT",
        //"LIST_SNAPSHOTS",
        "CLONE_VOLUME",
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

  assertCapabilities(capabilities) {
    const driver = this;
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    let fs_types = driver.getFsTypes();
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
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
  // share paths
  getShareBasePath() {
    let config_key = this.getConfigKey();
    let path = this.options[config_key].shareBasePath;
    if (!path) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing shareBasePath`
      );
    }

    path = path.replace(/\/$/, "");
    if (!path) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing shareBasePath`
      );
    }

    return path;
  }

  // controller paths
  getControllerBasePath() {
    let config_key = this.getConfigKey();
    let path = this.options[config_key].controllerBasePath;
    if (!path) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing controllerBasePath`
      );
    }

    path = path.replace(/\/$/, "");
    if (!path) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing controllerBasePath`
      );
    }

    return path;
  }

  // path helpers
  getVolumeExtraPath() {
    return "/v";
  }

  getSnapshotExtraPath() {
    return "/s";
  }

  getShareVolumeBasePath() {
    return this.getShareBasePath() + this.getVolumeExtraPath();
  }

  getShareSnapshotBasePath() {
    return this.getShareBasePath() + this.getSnapshotExtraPath();
  }

  getShareVolumePath(volume_id) {
    return this.getShareVolumeBasePath() + "/" + volume_id;
  }

  getShareSnapshotPath(snapshot_id) {
    return this.getShareSnapshotBasePath() + "/" + snapshot_id;
  }

  getControllerVolumeBasePath() {
    return this.getControllerBasePath() + this.getVolumeExtraPath();
  }

  getControllerSnapshotBasePath() {
    return this.getControllerBasePath() + this.getSnapshotExtraPath();
  }

  getControllerVolumePath(volume_id) {
    return this.getControllerVolumeBasePath() + "/" + volume_id;
  }

  getControllerSnapshotPath(snapshot_id) {
    return this.getControllerSnapshotBasePath() + "/" + snapshot_id;
  }

  async getDirectoryUsage(path) {
    if (this.getNodeIsWindows()) {
      this.ctx.logger.warn("du not implemented on windows");
      return 0;
    } else {
      let result = await this.exec("du", ["-s", "--block-size=1", path]);
      let size = result.stdout.split("\t", 1)[0];
      return size;
    }
  }

  exec(command, args, options = {}) {
    args = args || [];

    let timeout;
    let stdout = "";
    let stderr = "";

    if (options.sudo) {
      args.unshift(command);
      command = "sudo";
    }
    console.log("executing command: %s %s", command, args.join(" "));
    const child = cp.spawn(command, args, options);

    let didTimeout = false;
    if (options && options.timeout) {
      timeout = setTimeout(() => {
        didTimeout = true;
        child.kill(options.killSignal || "SIGTERM");
      }, options.timeout);
    }

    return new Promise((resolve, reject) => {
      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr };
        if (timeout) {
          clearTimeout(timeout);
        }
        if (code) {
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }

  stripTrailingSlash(s) {
    if (s.length > 1) {
      return s.replace(/\/$/, "");
    }

    return s;
  }

  stripLeadingSlash(s) {
    if (s.length > 1) {
      return s.replace(/^\/+/, "");
    }

    return s;
  }

  async cloneDir(source_path, target_path) {
    if (this.getNodeIsWindows()) {
      fse.copySync(
        this.stripTrailingSlash(source_path),
        this.stripTrailingSlash(target_path),
        {
          overwrite: true,
          dereference: true,
          preserveTimestamps: true,
          //errorOnExist: true,
        }
      );
    } else {
      await this.createDir(target_path);

      /**
       * trailing / is important
       * rsync -a /mnt/storage/s/foo/ /mnt/storage/v/PVC-111/
       */
      await this.exec("rsync", [
        "-a",
        this.stripTrailingSlash(source_path) + "/",
        this.stripTrailingSlash(target_path) + "/",
      ]);
    }
  }

  async getAvailableSpaceAtPath(path) {
    // https://www.npmjs.com/package/diskusage
    // https://www.npmjs.com/package/check-disk-space
    if (this.getNodeIsWindows()) {
      this.ctx.logger.warn("df not implemented on windows");
      return 0;
    }
    //df --block-size=1 --output=avail /mnt/storage/
    //     Avail
    //1481334328

    const response = await this.exec("df", [
      "--block-size=1",
      "--output=avail",
      path,
    ]);

    return response.stdout.split("\n")[1].trim();
  }

  async createDir(path) {
    fs.mkdirSync(path, {
      recursive: true,
      mode: "755",
    });
  }

  async deleteDir(path) {
    fs.rmSync(path, { recursive: true, force: true });

    return;

    /**
     * trailing / is important
     * rsync -a /mnt/storage/s/foo/ /mnt/storage/v/PVC-111/
     */
    await this.exec("rsync", [
      "-a",
      "--delete",
      this.stripTrailingSlash(empty_path) + "/",
      this.stripTrailingSlash(path) + "/",
    ]);
  }

  async directoryExists(path) {
    let r;
    r = fs.existsSync(path);
    if (!r) {
      return r;
    }

    if (!fs.statSync(path).isDirectory()) {
      throw new Error(`path [${path}] exists but is not a directory`);
    }

    return true;
  }

  /**
   * Have to be careful with the logic here as the controller could be running
   * on win32 for *-client vs local-hostpath
   *
   * @param {*} path
   * @returns
   */
  async normalizePath(path) {
    if (process.platform == "win32") {
      return await this.noramlizePathWin32(path);
    } else {
      return await this.normalizePathPosix(path);
    }
  }

  async normalizePathPosix(p) {
    return p.replaceAll(path.win32.sep, path.posix.sep);
  }

  async noramlizePathWin32(p) {
    return p.replaceAll(path.posix.sep, path.win32.sep);
  }

  /**
   * Create a volume doing in essence the following:
   * 1. create directory
   *
   * Should return 2 parameters
   * 1. `server` - host/ip of the nfs server
   * 2. `share` - path of the mount shared
   *
   * @param {*} call
   */
  async CreateVolume(call) {
    const driver = this;

    let config_key = this.getConfigKey();
    let volume_id = await driver.getVolumeIdFromCall(call);
    let volume_content_source = call.request.volume_content_source;

    if (
      call.request.volume_capabilities &&
      call.request.volume_capabilities.length > 0
    ) {
      const result = this.assertCapabilities(call.request.volume_capabilities);
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

    const volume_path = driver.getControllerVolumePath(volume_id);

    let response;
    let source_path;
    //let volume_content_source_snapshot_id;
    //let volume_content_source_volume_id;

    // create target dir
    await driver.createDir(volume_path);

    // create dataset
    if (volume_content_source) {
      switch (volume_content_source.type) {
        // must be available when adverstising CREATE_DELETE_SNAPSHOT
        // simply clone
        case "snapshot":
          source_path = driver.getControllerSnapshotPath(
            volume_content_source.snapshot.snapshot_id
          );
          break;
        // must be available when adverstising CLONE_VOLUME
        // create snapshot first, then clone
        case "volume":
          source_path = driver.getControllerVolumePath(
            volume_content_source.volume.volume_id
          );
          break;
        default:
          throw new GrpcError(
            grpc.status.INVALID_ARGUMENT,
            `invalid volume_content_source type: ${volume_content_source.type}`
          );
          break;
      }

      if (!(await driver.directoryExists(source_path))) {
        throw new GrpcError(
          grpc.status.NOT_FOUND,
          `invalid volume_content_source path: ${source_path}`
        );
      }

      driver.ctx.logger.debug("controller source path: %s", source_path);
      await driver.cloneDir(source_path, volume_path);
    }

    // set mode
    if (this.options[config_key].dirPermissionsMode) {
      driver.ctx.logger.verbose(
        "setting dir mode to: %s on dir: %s",
        this.options[config_key].dirPermissionsMode,
        volume_path
      );
      fs.chmodSync(volume_path, this.options[config_key].dirPermissionsMode);
    }

    // set ownership
    if (
      this.options[config_key].dirPermissionsUser ||
      this.options[config_key].dirPermissionsGroup
    ) {
      driver.ctx.logger.verbose(
        "setting ownership to: %s:%s on dir: %s",
        this.options[config_key].dirPermissionsUser,
        this.options[config_key].dirPermissionsGroup,
        volume_path
      );
      if (this.getNodeIsWindows()) {
        driver.ctx.logger.warn("chown not implemented on windows");
      } else {
        await driver.exec("chown", [
          (this.options[config_key].dirPermissionsUser
            ? this.options[config_key].dirPermissionsUser
            : "") +
            ":" +
            (this.options[config_key].dirPermissionsGroup
              ? this.options[config_key].dirPermissionsGroup
              : ""),
          volume_path,
        ]);
      }
    }

    let volume_context = driver.getVolumeContext(volume_id);

    volume_context["provisioner_driver"] = driver.options.driver;
    if (driver.options.instance_id) {
      volume_context["provisioner_driver_instance_id"] =
        driver.options.instance_id;
    }

    let accessible_topology;
    if (typeof this.getAccessibleTopology === "function") {
      accessible_topology = await this.getAccessibleTopology();
    }

    const res = {
      volume: {
        volume_id,
        //capacity_bytes: capacity_bytes, // kubernetes currently pukes if capacity is returned as 0
        capacity_bytes: 0,
        content_source: volume_content_source,
        volume_context,
        accessible_topology,
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

    let volume_id = call.request.volume_id;

    if (!volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    const volume_path = driver.getControllerVolumePath(volume_id);
    await driver.deleteDir(volume_path);

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
    const driver = this;

    if (
      !driver.options.service.controller.capabilities.rpc.includes(
        "GET_CAPACITY"
      )
    ) {
      // really capacity is not used at all with nfs in this fashion, so no reason to enable
      // here even though it is technically feasible.
      throw new GrpcError(
        grpc.status.UNIMPLEMENTED,
        `operation not supported by driver`
      );
    }

    if (call.request.volume_capabilities) {
      const result = this.assertCapabilities(call.request.volume_capabilities);

      if (result.valid !== true) {
        return { available_capacity: 0 };
      }
    }

    if (!(await driver.directoryExists(driver.getControllerBasePath()))) {
      await driver.createDir(driver.getControllerBasePath());
    }

    const available_capacity = await driver.getAvailableSpaceAtPath(
      driver.getControllerBasePath()
    );
    return { available_capacity };
  }

  /**
   *
   * TODO: check capability to ensure not asking about block volumes
   *
   * @param {*} call
   */
  async ListVolumes(call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
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
    const driver = this;

    // both these are required
    let source_volume_id = call.request.source_volume_id;
    let name = call.request.name;

    if (!source_volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot source_volume_id is required`
      );
    }

    if (!name) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot name is required`
      );
    }

    driver.ctx.logger.verbose("requested snapshot name: %s", name);

    let invalid_chars;
    invalid_chars = name.match(/[^a-z0-9_\-:.+]+/gi);
    if (invalid_chars) {
      invalid_chars = String.prototype.concat(
        ...new Set(invalid_chars.join(""))
      );
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot name contains invalid characters: ${invalid_chars}`
      );
    }

    // https://stackoverflow.com/questions/32106243/regex-to-remove-all-non-alpha-numeric-and-replace-spaces-with/32106277
    name = name.replace(/[^a-z0-9_\-:.+]+/gi, "");

    driver.ctx.logger.verbose("cleansed snapshot name: %s", name);

    const snapshot_id = `${source_volume_id}-${name}`;
    const volume_path = driver.getControllerVolumePath(source_volume_id);
    const snapshot_path = driver.getControllerSnapshotPath(snapshot_id);

    // do NOT overwrite existing snapshot
    if (!(await driver.directoryExists(snapshot_path))) {
      await driver.cloneDir(volume_path, snapshot_path);
    }

    let size_bytes = await driver.getDirectoryUsage(snapshot_path);
    return {
      snapshot: {
        /**
         * The purpose of this field is to give CO guidance on how much space
         * is needed to create a volume from this snapshot.
         */
        size_bytes,
        snapshot_id,
        source_volume_id: source_volume_id,
        //https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/timestamp.proto
        creation_time: {
          seconds: Math.round(new Date().getTime() / 1000),
          nanos: 0,
        },
        ready_to_use: true,
      },
    };
  }

  /**
   * In addition, if clones have been created from a snapshot, then they must
   * be destroyed before the snapshot can be destroyed.
   *
   * @param {*} call
   */
  async DeleteSnapshot(call) {
    const driver = this;

    const snapshot_id = call.request.snapshot_id;

    if (!snapshot_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot_id is required`
      );
    }

    const snapshot_path = driver.getControllerSnapshotPath(snapshot_id);
    await driver.deleteDir(snapshot_path);

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(call) {
    const driver = this;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }

    const capabilities = call.request.volume_capabilities;
    if (!capabilities || capabilities.length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capabilities`);
    }

    const volume_path = driver.getControllerVolumePath(volume_id);
    if (!(await driver.directoryExists(volume_path))) {
      throw new GrpcError(
        grpc.status.NOT_FOUND,
        `invalid volume_id: ${volume_id}`
      );
    }

    const result = this.assertCapabilities(call.request.volume_capabilities);

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

module.exports.ControllerClientCommonDriver = ControllerClientCommonDriver;
