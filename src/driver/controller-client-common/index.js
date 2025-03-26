const _ = require("lodash");
const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const cp = require("child_process");
const fs = require("fs");
const fse = require("fs-extra");
const Kopia = require("../../utils/kopia").Kopia;
const os = require("os");
const path = require("path");
const Restic = require("../../utils/restic").Restic;
const semver = require("semver");

const __REGISTRY_NS__ = "ControllerClientCommonDriver";

// https://forum.restic.net/t/how-to-prevent-two-restic-tasks-concurrently/6859/5
const SNAPSHOTS_CUT_IN_FLIGHT = new Set();
const SNAPSHOTS_RESTORE_IN_FLIGHT = new Set();
const DEFAULT_SNAPSHOT_DRIVER = "filecopy";

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

    if (this.ctx.args.csiMode.includes("controller")) {
      setInterval(() => {
        this.ctx.logger.info("snapshots cut in flight", {
          names: [...SNAPSHOTS_CUT_IN_FLIGHT],
          count: SNAPSHOTS_CUT_IN_FLIGHT.size,
        });
      }, 30 * 1000);
      setInterval(() => {
        this.ctx.logger.info("snapshots restore in flight", {
          names: [...SNAPSHOTS_RESTORE_IN_FLIGHT],
          count: SNAPSHOTS_RESTORE_IN_FLIGHT.size,
        });
      }, 30 * 1000);
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

  assertCapabilities(callContext, capabilities) {
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

  async getResticClient() {
    const driver = this;

    return this.ctx.registry.get(`${__REGISTRY_NS__}:restic`, () => {
      const config_key = driver.getConfigKey();

      const restic_env = _.get(
        driver.options[config_key],
        "snapshots.restic.env",
        {}
      );

      const restic_global_flags = _.get(
        driver.options[config_key],
        "snapshots.restic.global_flags",
        []
      );
      const client = new Restic({
        env: restic_env,
        logger: driver.ctx.logger,
        global_flags: restic_global_flags,
      });

      let hostname = driver.ctx.args.csiName;
      if (driver.options.driver == "local-hostpath") {
        let nodename = process.env.CSI_NODE_ID || os.hostname();
        hostname = `${hostname}-${nodename}`;
      }

      return client;
    });
  }

  async getKopiaClient() {
    const driver = this;

    return this.ctx.registry.getAsync(`${__REGISTRY_NS__}:kopia`, async () => {
      const config_key = driver.getConfigKey();

      const kopia_env = _.get(
        driver.options[config_key],
        "snapshots.kopia.env",
        {}
      );

      const kopia_global_flags = _.get(
        driver.options[config_key],
        "snapshots.kopia.global_flags",
        []
      );
      const client = new Kopia({
        env: kopia_env,
        logger: driver.ctx.logger,
        global_flags: kopia_global_flags,
      });

      let hostname = driver.ctx.args.csiName;
      if (driver.options.driver == "local-hostpath") {
        let nodename = process.env.CSI_NODE_ID || os.hostname();
        hostname = `${hostname}-${nodename}`;
      }

      let username = "democratic-csi";

      await client.repositoryConnect([
        "--override-hostname",
        hostname,
        "--override-username",
        username,
        "from-config",
        "--token",
        _.get(driver.options[config_key], "snapshots.kopia.config_token", ""),
      ]);

      //let repositoryStatus = await client.repositoryStatus();
      //console.log(repositoryStatus);

      client.hostname = hostname;
      client.username = username;

      return client;
    });
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
  async CreateVolume(callContext, call) {
    const driver = this;

    const config_key = driver.getConfigKey();
    const volume_id = await driver.getVolumeIdFromCall(call);
    const volume_content_source = call.request.volume_content_source;
    const instance_id = driver.options.instance_id;

    if (
      call.request.volume_capabilities &&
      call.request.volume_capabilities.length > 0
    ) {
      const result = this.assertCapabilities(callContext, call.request.volume_capabilities);
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
      let snapshot_driver;
      let snapshot_id;

      if (volume_content_source.type == "snapshot") {
        snapshot_id = volume_content_source.snapshot.snapshot_id;

        // get parsed variant of driver to allow snapshotter to work with all
        // drivers simultaneously
        const parsed_snapshot_id = new URLSearchParams(snapshot_id);
        if (parsed_snapshot_id.get("snapshot_driver")) {
          snapshot_id = parsed_snapshot_id.get("snapshot_id");
          snapshot_driver = parsed_snapshot_id.get("snapshot_driver");
        } else {
          snapshot_driver = "filecopy";
        }
      }

      switch (volume_content_source.type) {
        // must be available when adverstising CREATE_DELETE_SNAPSHOT
        // simply clone
        case "snapshot":
          switch (snapshot_driver) {
            case "filecopy":
              {
                source_path = driver.getControllerSnapshotPath(snapshot_id);

                if (!(await driver.directoryExists(source_path))) {
                  throw new GrpcError(
                    grpc.status.NOT_FOUND,
                    `invalid volume_content_source path: ${source_path}`
                  );
                }

                driver.ctx.logger.debug(
                  "controller volume source path: %s",
                  source_path
                );
                await driver.cloneDir(source_path, volume_path);
              }
              break;
            case "restic":
              {
                const restic = await driver.getResticClient();

                let options = [];
                await restic.init();

                // find snapshot
                options = [snapshot_id];
                const snapshots = await restic.snapshots(options);
                if (!snapshots.length > 0) {
                  throw new GrpcError(
                    grpc.status.NOT_FOUND,
                    `invalid restic snapshot volume_content_source: ${snapshot_id}`
                  );
                }
                const snapshot = snapshots[snapshots.length - 1];

                // restore snapshot
                // --verify?
                options = [
                  `${snapshot.id}:${snapshot.paths[0]}`,
                  "--target",
                  volume_path,
                  "--sparse",
                  "--host",
                  restic.hostname,
                ];

                // technically same snapshot could be getting restored to multiple volumes simultaneously
                // ensure we add target path as part of the key
                SNAPSHOTS_RESTORE_IN_FLIGHT.add(
                  `${snapshot_id}:${volume_path}`
                );
                await restic.restore(options).finally(() => {
                  SNAPSHOTS_RESTORE_IN_FLIGHT.delete(
                    `${snapshot_id}:${volume_path}`
                  );
                });
              }
              break;
            case "kopia":
              {
                const kopia = await driver.getKopiaClient();
                const snapshot = await kopia.snapshotGet(snapshot_id);

                if (!snapshot) {
                  throw new GrpcError(
                    grpc.status.NOT_FOUND,
                    `invalid restic snapshot volume_content_source: ${snapshot_id}`
                  );
                }

                /**
                 * --[no-]write-files-atomically
                 * --[no-]write-sparse-files
                 */
                let options = [
                  "--write-sparse-files",
                  snapshot_id,
                  volume_path,
                ];
                await kopia.snapshotRestore(options);
              }
              break;
            default:
              throw new GrpcError(
                grpc.status.INVALID_ARGUMENT,
                `unknown snapthot driver: ${snapshot_driver}`
              );
          }
          break;
        // must be available when adverstising CLONE_VOLUME
        // create snapshot first, then clone
        case "volume":
          source_path = driver.getControllerVolumePath(
            volume_content_source.volume.volume_id
          );

          if (!(await driver.directoryExists(source_path))) {
            throw new GrpcError(
              grpc.status.NOT_FOUND,
              `invalid volume_content_source path: ${source_path}`
            );
          }

          driver.ctx.logger.debug(
            "controller volume source path: %s",
            source_path
          );
          await driver.cloneDir(source_path, volume_path);
          break;
        default:
          throw new GrpcError(
            grpc.status.INVALID_ARGUMENT,
            `invalid volume_content_source type: ${volume_content_source.type}`
          );
      }
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
  async DeleteVolume(callContext, call) {
    const driver = this;

    const volume_id = call.request.volume_id;

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

    const volume_path = driver.getControllerVolumePath(volume_id);
    await driver.deleteDir(volume_path);

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ControllerExpandVolume(callContext, call) {
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
  async GetCapacity(callContext, call) {
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
      const result = this.assertCapabilities(callContext, call.request.volume_capabilities);

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
  async ListVolumes(callContext, call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   *
   * @param {*} call
   */
  async ListSnapshots(callContext, call) {
    throw new GrpcError(
      grpc.status.UNIMPLEMENTED,
      `operation not supported by driver`
    );
  }

  /**
   * Create snapshot is meant to be a syncronous call to 'cut' the snapshot
   * in the case of rsync/restic/kopia/etc tooling a 'cut' can take a very
   * long time. It was deemed appropriate to continue to wait vs making the
   * call async with `ready_to_use` false.
   *
   * Restic:
   * With restic the idea is to keep the tree scoped to each volume. Each
   * new snapshot for the same volume should have a parent of the most recently
   * cut snapshot for the same volume. Behind the scenes restic is applying
   * dedup logic globally in the repo so efficiency should still be extremely
   * efficient.
   *
   * Kopia:
   *
   *
   * https://github.com/container-storage-interface/spec/blob/master/spec.md#createsnapshot
   *
   * @param {*} call
   */
  async CreateSnapshot(callContext, call) {
    const driver = this;

    const config_key = driver.getConfigKey();
    let snapshot_driver = _.get(
      driver.options[config_key],
      "snapshots.default_driver",
      DEFAULT_SNAPSHOT_DRIVER
    );

    // randomize driver for testing
    //if (process.env.CSI_SANITY == "1") {
    //  call.request.parameters.driver = ["filecopy", "restic", "kopia"].random();
    //}

    if (call.request.parameters.driver) {
      snapshot_driver = call.request.parameters.driver;
    }

    const instance_id = driver.options.instance_id;
    let response;

    // both these are required
    const source_volume_id = call.request.source_volume_id;
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
    const volume_path = driver.getControllerVolumePath(source_volume_id);
    //const volume_path = "/home/thansen/beets/";
    //const volume_path = "/var/lib/docker/";

    let snapshot_id;
    let size_bytes = 0;
    let ready_to_use = true;
    let snapshot_date = new Date();

    switch (snapshot_driver) {
      case "filecopy":
        {
          snapshot_id = `${source_volume_id}-${name}`;
          const snapshot_path = driver.getControllerSnapshotPath(snapshot_id);
          const snapshot_dir_exists = await driver.directoryExists(
            snapshot_path
          );
          // do NOT overwrite existing snapshot
          if (!snapshot_dir_exists) {
            SNAPSHOTS_CUT_IN_FLIGHT.add(name);
            await driver.cloneDir(volume_path, snapshot_path).finally(() => {
              SNAPSHOTS_CUT_IN_FLIGHT.delete(name);
            });
            driver.ctx.logger.info(
              `filecopy backup finished: snapshot_id=${snapshot_id}, path=${volume_path}`
            );
          } else {
            driver.ctx.logger.debug(
              `filecopy backup already cut: ${snapshot_id}`
            );
          }

          size_bytes = await driver.getDirectoryUsage(snapshot_path);
        }
        break;
      case "restic":
        {
          const restic = await driver.getResticClient();
          const group_by_options = ["--group-by", "host,paths,tags"];
          let snapshot_exists = false;

          // --tag specified multiple times is OR logic, comma-separated is AND logic
          let base_tag_option = `source=democratic-csi`;
          base_tag_option += `,csi_volume_id=${source_volume_id}`;
          if (instance_id) {
            base_tag_option += `csi_instance_id=${instance_id}`;
          }

          let options = [];

          /**
           * ensure repo has been initted
           *
           * it is expected that at a minimum the following env vars are set
           * RESTIC_PASSWORD
           * RESTIC_REPOSITORY
           */
          options = [];
          await restic.init();

          // see if snapshot already exist with matching tags, etc
          options = [
            "--path",
            volume_path.replace(/\/$/, ""),
            "--host",
            restic.hostname,
          ];

          // when searching for existing snapshot include name
          response = await restic.snapshots(
            options
              .concat(group_by_options)
              .concat(["--tag", base_tag_option + `,csi_snapshot_name=${name}`])
          );

          if (response.length > 0) {
            snapshot_exists = true;
            const snapshot = response[response.length - 1];
            driver.ctx.logger.debug(
              `restic backup already cut: ${snapshot.id}`
            );
            const stats = await restic.stats([snapshot.id]);

            snapshot_id = snapshot.id;
            snapshot_date = new Date(snapshot.time);
            size_bytes = stats.total_size;
          }

          if (!snapshot_exists) {
            //       --no-scan                                do not run scanner to estimate size of backup
            //  -x, --one-file-system                        exclude other file systems, don't cross filesystem boundaries and subvolumes
            options = [
              "--host",
              restic.hostname,
              "--one-file-system",
              //"--no-scan",
            ];

            // backup with minimal tags to ensure a sane parent for the volume (since tags are included in group_by)
            SNAPSHOTS_CUT_IN_FLIGHT.add(name);
            response = await restic
              .backup(
                volume_path,
                options
                  .concat(group_by_options)
                  .concat(["--tag", base_tag_option])
              )
              .finally(() => {
                SNAPSHOTS_CUT_IN_FLIGHT.delete(name);
              });
            response.parsed.reverse();
            let summary = response.parsed.find((message) => {
              return message.message_type == "summary";
            });
            snapshot_id = summary.snapshot_id;
            driver.ctx.logger.info(
              `restic backup finished: snapshot_id=${snapshot_id}, path=${volume_path}, total_duration=${
                summary.total_duration | 0
              }s`
            );
            const stats = await restic.stats([snapshot_id]);
            size_bytes = stats.total_size;

            // only apply these tags at creation, do NOT use for search above etc
            let add_tags = `csi_snapshot_name=${name}`;
            let config_tags = _.get(
              driver.options[config_key],
              "snapshots.restic.tags",
              []
            );

            if (config_tags.length > 0) {
              add_tags += `,${config_tags.join(",")}`;
            }

            await restic.tag([
              "--path",
              volume_path.replace(/\/$/, ""),
              "--host",
              restic.hostname,
              "--add",
              add_tags,
              snapshot_id,
            ]);

            // this is ugly, the tag operation should output the new id, so we
            // must resort to full query of all snapshots for the volume
            // find snapshot using `original` id as adding tags creates a new id
            options = [
              "--path",
              volume_path.replace(/\/$/, ""),
              "--host",
              restic.hostname,
            ];
            response = await restic.snapshots(
              options
                .concat(group_by_options)
                .concat([
                  "--tag",
                  `${base_tag_option},csi_snapshot_name=${name}`,
                ])
            );
            let original_snapshot_id = snapshot_id;
            let snapshot = response.find((snapshot) => {
              return snapshot.original == original_snapshot_id;
            });
            if (!snapshot) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `failed to find snapshot post-tag operation: snapshot_id=${original_snapshot_id}`
              );
            }
            snapshot_id = snapshot.id;
            driver.ctx.logger.info(
              `restic backup successfully applied additional tags: new_snapshot_id=${snapshot_id}, original_snapshot_id=${original_snapshot_id} path=${volume_path}`
            );
          }
        }
        break;
      case "kopia":
        {
          const kopia = await driver.getKopiaClient();
          let options = [];

          let snapshot_exists = false;

          // --tags specified multiple times means snapshot must contain ALL supplied tags
          let tags = [];
          tags.push(`source:democratic-csi`);
          tags.push(`csi_volume_id:${source_volume_id}`);
          if (instance_id) {
            tags.push(`csi_instance_id:${instance_id}`);
          }
          tags.push(`csi_snapshot_name:${name}`);

          options = ["--no-storage-stats", "--no-delta"];
          tags.forEach((item) => {
            options.push("--tags", item);
          });

          options.push(
            `${kopia.username}@${kopia.hostname}:${volume_path.replace(
              /\/$/,
              ""
            )}`
          );

          response = await kopia.snapshotList(options);

          if (response.length > 0) {
            snapshot_exists = true;
            const snapshot = response[response.length - 1];
            driver.ctx.logger.debug(
              `kopia snapshot already cut: ${snapshot.id}`
            );

            snapshot_id = snapshot.id;
            snapshot_date = new Date(snapshot.startTime); // maybe use endTime?
            size_bytes = snapshot.stats.totalSize;
          }

          if (!snapshot_exists) {
            // create snapshot
            options = [];
            tags.forEach((item) => {
              options.push("--tags", item);
            });
            options.push(volume_path);
            SNAPSHOTS_CUT_IN_FLIGHT.add(name);
            response = await kopia.snapshotCreate(options).finally(() => {
              SNAPSHOTS_CUT_IN_FLIGHT.delete(name);
            });

            snapshot_id = response.id;
            snapshot_date = new Date(response.startTime); // maybe use endTime?
            let snapshot_end_date = new Date(response.endTime);
            let total_duration =
              Math.abs(snapshot_end_date.getTime() - snapshot_date.getTime()) /
              1000;
            size_bytes = response.rootEntry.summ.size;

            driver.ctx.logger.info(
              `kopia backup finished: snapshot_id=${snapshot_id}, path=${volume_path}, total_duration=${
                total_duration | 0
              }s`
            );
          }
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unknown snapthot driver: ${snapshot_driver}`
        );
    }

    return {
      snapshot: {
        /**
         * The purpose of this field is to give CO guidance on how much space
         * is needed to create a volume from this snapshot.
         */
        size_bytes,
        snapshot_id: new URLSearchParams({
          snapshot_driver,
          snapshot_id,
        }).toString(),
        source_volume_id: source_volume_id,
        //https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/timestamp.proto
        creation_time: {
          seconds: Math.round(snapshot_date.getTime() / 1000),
          nanos: 0,
        },
        ready_to_use,
      },
    };
  }

  /**
   * In addition, if clones have been created from a snapshot, then they must
   * be destroyed before the snapshot can be destroyed.
   *
   * @param {*} call
   */
  async DeleteSnapshot(callContext, call) {
    const driver = this;

    let snapshot_id = call.request.snapshot_id;
    let snapshot_driver;
    const config_key = driver.getConfigKey();
    const instance_id = driver.options.instance_id;
    let response;

    if (!snapshot_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot_id is required`
      );
    }

    // get parsed variant of driver to allow snapshotter to work with all
    // drivers simultaneously
    const parsed_snapshot_id = new URLSearchParams(snapshot_id);
    if (parsed_snapshot_id.get("snapshot_driver")) {
      snapshot_id = parsed_snapshot_id.get("snapshot_id");
      snapshot_driver = parsed_snapshot_id.get("snapshot_driver");
    } else {
      snapshot_driver = "filecopy";
    }

    switch (snapshot_driver) {
      case "filecopy":
        {
          const snapshot_path = driver.getControllerSnapshotPath(snapshot_id);
          await driver.deleteDir(snapshot_path);
        }
        break;
      case "restic":
        {
          let prune = _.get(
            driver.options[config_key],
            "snapshots.restic.prune",
            false
          );

          if (typeof prune != "boolean") {
            prune = String(prune);
            if (["true", "yes", "1"].includes(prune.toLowerCase())) {
              prune = true;
            } else {
              prune = false;
            }
          }

          const restic = await driver.getResticClient();

          let options = [];
          await restic.init();

          // we preempt with this check to prevent locking the repo when snapshot does not exist
          const snapshot_exists = await restic.snapshot_exists(snapshot_id);
          if (snapshot_exists) {
            options = [];
            if (prune) {
              options.push("--prune");
            }
            options.push(snapshot_id);
            await restic.forget(options);
          }
        }
        break;
      case "kopia":
        {
          const kopia = await driver.getKopiaClient();
          let options = [snapshot_id];
          await kopia.snapshotDelete(options);
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `unknown snapthot driver: ${snapshot_driver}`
        );
    }

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(callContext, call) {
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

    const result = this.assertCapabilities(callContext, call.request.volume_capabilities);

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
