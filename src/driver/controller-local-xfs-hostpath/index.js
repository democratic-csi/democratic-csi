const _ = require("lodash");
const fs = require("fs");
const cp = require("child_process");

const { ControllerClientCommonDriver } = require("../controller-client-common");

const NODE_TOPOLOGY_KEY_NAME = "org.democratic-csi.topology/node";

const XFS_PROJECT_ID_FILE = ".csi-xfs-project-id";

/**
 * local-xfs-hostpath driver: same structure as local-hostpath but with
 * XFS-specific behaviours layered on top:
 *  - filesystem verification (XFS only) at startup and on every volume op
 *  - per-PVC XFS project-quota enforcement
 *  - CoW reflink snapshots instead of rsync/restic/kopia
 */
class ControllerLocalXfsHostpathDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    const i_caps = _.get(
      options,
      "service.identity.capabilities.service",
      false
    );

    const c_caps = _.get(options, "service.controller.capabilities", false);
    super(...arguments);

    if (!i_caps) {
      this.ctx.logger.debug("setting local-xfs-hostpath identity service caps");

      options.service.identity.capabilities.service = [
        "CONTROLLER_SERVICE",
        "VOLUME_ACCESSIBILITY_CONSTRAINTS",
      ];
    }

    if (!c_caps) {
      this.ctx.logger.debug(
        "setting local-xfs-hostpath controller service caps"
      );

      if (
        !options.service.controller.capabilities.rpc.includes("GET_CAPACITY")
      ) {
        options.service.controller.capabilities.rpc.push("GET_CAPACITY");
      }

      if (
        !options.service.controller.capabilities.rpc.includes("EXPAND_VOLUME")
      ) {
        options.service.controller.capabilities.rpc.push("EXPAND_VOLUME");
      }
    }
  }

  getConfigKey() {
    return "local-xfs-hostpath";
  }

  getVolumeContext(volume_id) {
    const driver = this;
    return {
      node_attach_driver: "hostpath",
      path: driver.getShareVolumePath(volume_id),
    };
  }

  getFsTypes() {
    return ["xfs"];
  }

  async getAccessibleTopology() {
    const response = await super.NodeGetInfo(...arguments);
    return [
      {
        segments: {
          [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
        },
      },
    ];
  }

  async NodeGetInfo(call) {
    const response = await super.NodeGetInfo(...arguments);
    response.accessible_topology = {
      segments: {
        [NODE_TOPOLOGY_KEY_NAME]: response.node_id,
      },
    };
    return response;
  }

  /**
   * Verify that `path` is on an XFS filesystem.
   * Uses `findmnt -n -o FSTYPE --target <path>` and asserts output is `xfs`.
   *
   * @param {string} path
   * @returns {Promise<boolean>} true if XFS
   * @throws {Error} if not XFS
   */
  async assertXfs(path) {
    const driver = this;
    try {
      const result = await driver.exec("findmnt", [
        "-n",
        "-o",
        "FSTYPE",
        "--target",
        path,
      ]);
      const fstype = result.stdout.trim();
      if (fstype !== "xfs") {
        throw new Error(
          `path ${path} is on filesystem type '${fstype}', expected 'xfs'`
        );
      }
      driver.ctx.logger.debug(`verified path ${path} is on XFS`);
      return true;
    } catch (err) {
      if (err.code && err.code !== 0) {
        throw new Error(
          `failed to verify XFS for path ${path}: ${err.stderr || err.message}`
        );
      }
      throw err;
    }
  }

  /**
   * Allocate or read a project ID for the volume, persist it alongside the
   * volume directory so ControllerExpandVolume and re-apply are idempotent.
   *
   * @param {string} volumePath - absolute path to the volume directory
   * @param {number|string} bytes - quota size in bytes
   * @returns {Promise<number>} project ID
   */
  async setXfsProjectQuota(volumePath, bytes) {
    const driver = this;
    const configKey = driver.getConfigKey();
    const mountpoint = driver.getControllerBasePath();

    let projId = driver._readXfsProjectIdFile(volumePath);
    if (!projId) {
      // derive deterministically from volume_id (stored as basename of volumePath)
      const volumeId = driver._extractVolumeIdFromPath(volumePath);
      projId = driver._deriveProjectId(volumeId);
      driver._writeXfsProjectIdFile(volumePath, projId);
    }

    // project -s binds the project to the directory
    await driver.exec("xfs_quota", [
      "-x",
      "-c",
      `project -s -p ${volumePath} ${projId}`,
      mountpoint,
    ]);

    // limit -p sets the soft/hard byte quota for the project
    const bsoft = bytes;
    const bhard = bytes;
    await driver.exec("xfs_quota", [
      "-x",
      "-c",
      `limit -p bsoft=${bsoft} bhard=${bhard} ${projId}`,
      mountpoint,
    ]);

    driver.ctx.logger.info(
      `set XFS project quota projid=${projId} bytes=${bytes} on path=${volumePath}`
    );
    return projId;
  }

  /**
   * Clear the XFS project quota for a volume so project IDs are not leaked.
   *
   * @param {string} volumePath - absolute path to the volume directory
   */
  async clearXfsProjectQuota(volumePath) {
    const driver = this;
    const configKey = driver.getConfigKey();
    const mountpoint = driver.getControllerBasePath();

    let projId = driver._readXfsProjectIdFile(volumePath);
    if (projId) {
      try {
        await driver.exec("xfs_quota", [
          "-x",
          "-c",
          `limit -p -d ${projId}`,
          mountpoint,
        ]);
        driver.ctx.logger.info(
          `cleared XFS project quota projid=${projId} on path=${volumePath}`
        );
      } catch (err) {
        driver.ctx.logger.warn(
          `failed to clear XFS project quota projid=${projId}: ${err.message}`
        );
      }
    }

    // remove the sidecar file
    const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
    try {
      fs.unlinkSync(idFilePath);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Reflink-copy a directory tree. Atomic per-file, CoW across the whole tree.
   * Uses `cp --archive --reflink=always` which fails if reflink is unsupported.
   *
   * @param {string} src
   * @param {string} dst
   */
  async reflinkCopy(src, dst) {
    const driver = this;
    await driver.createDir(dst);

    /**
     * trailing / is important — cp copies contents, not the directory itself
     */
    await driver.exec("cp", [
      "--archive",
      "--reflink=always",
      driver.stripTrailingSlash(src) + "/.", // copy everything inside src folder, but don't nest src folder in dst folder
      driver.stripTrailingSlash(dst) + "/",
    ]);
  }

  /**
   * Check that `src` and `dst` resolve to the same XFS filesystem.
   * Reflinks cannot cross filesystems.
   *
   * @param {string} srcPath
   * @param {string} dstPath
   */
  async assertSameXfsFilesystem(srcPath, dstPath) {
    const driver = this;
    const srcResult = await driver.exec("findmnt", [
      "-n",
      "-o",
      "SOURCE",
      "--target",
      srcPath,
    ]);
    const dstResult = await driver.exec("findmnt", [
      "-n",
      "-o",
      "SOURCE",
      "--target",
      dstPath,
    ]);

    if (srcResult.stdout.trim() !== dstResult.stdout.trim()) {
      throw new Error(
        `source ${srcPath} (${srcResult.stdout.trim()}) and destination ${dstPath} (${dstResult.stdout.trim()}) are on different filesystems; reflinks cannot cross filesystem boundaries`
      );
    }
  }

  /**
   * Read the persisted project ID file (if present).
   */
  _readXfsProjectIdFile(volumePath) {
    try {
      const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
      if (fs.existsSync(idFilePath)) {
        return parseInt(fs.readFileSync(idFilePath, "utf8").trim(), 10);
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  /**
   * Write the project ID to the sidecar file.
   */
  _writeXfsProjectIdFile(volumePath, projId) {
    const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
    fs.writeFileSync(idFilePath, String(projId), { mode: "0644" });
  }

  /**
   * Extract the volume_id from a controller volume path.
   * Path shape: <controllerBasePath>/v/<volume_id>
   */
  _extractVolumeIdFromPath(volumePath) {
    const basePath = this.getControllerVolumeBasePath();
    if (volumePath.startsWith(basePath + "/")) {
      return volumePath.slice(basePath.length + 1);
    }
    // fallback: last path component
    return volumePath.split("/").filter(Boolean).pop();
  }

  /**
   * Derive a project ID from a volume_id by hashing into the valid xfs_quota
   * range. Default range is [1000000, 1999999] — configurable via
   * xfs.project_id_range in the driver config.
   */
  _deriveProjectId(volumeId) {
    const configKey = this.getConfigKey();
    const range = _.get(
      this.options[configKey],
      "xfs.project_id_range",
      [1000000, 1999999]
    );

    // simple hash: sum of char codes mod range size + range start
    let hash = 0;
    for (let i = 0; i < volumeId.length; i++) {
      hash = (hash * 31 + volumeId.charCodeAt(i)) >>> 0;
    }

    const rangeSize = range[1] - range[0] + 1;
    return range[0] + (hash % rangeSize);
  }

  /**
   * Override CreateVolume to add XFS checks + quotas.
   */
  async CreateVolume(call) {
    const driver = this;
    const configKey = driver.getConfigKey();

    // validate volume capabilities against XFS fs_type requirement
    if (
      call.request.volume_capabilities &&
      call.request.volume_capabilities.length > 0
    ) {
      const result = this.assertCapabilities(call.request.volume_capabilities);
      if (result.valid !== true) {
        throw new Error(`invalid volume capabilities: ${result.message}`);
      }
    }

    // resolve volume_id
    let volume_id;
    try {
      volume_id = await driver.getVolumeIdFromCall(call);
    } catch (e) {
      throw e;
    }

    const volume_content_source = call.request.volume_content_source;
    const capacity_range = call.request.capacity_range || {};
    let capacity_bytes =
      capacity_range.required_bytes ||
      capacity_range.limit_bytes ||
      1073741824;

    if (
      capacity_range.required_bytes > 0 &&
      capacity_range.limit_bytes > 0 &&
      capacity_range.required_bytes > capacity_range.limit_bytes
    ) {
      throw new Error(`required_bytes is greater than limit_bytes`);
    }

    const volume_path = driver.getControllerVolumePath(volume_id);

    // ensure parent directories exist
    await driver.createDir(volume_path);

    // XFS verification on the volume path
    try {
      await driver.assertXfs(volume_path);
    } catch (err) {
      throw new Error(
        `CreateVolume failed XFS check for ${volume_path}: ${err.message}`
      );
    }

    let source_path;

    if (volume_content_source) {
      let snapshot_driver;
      let snapshot_id;

      if (volume_content_source.type === "snapshot") {
        snapshot_id = volume_content_source.snapshot.snapshot_id;
        const parsed_snapshot_id = new URLSearchParams(snapshot_id);
        if (parsed_snapshot_id.get("snapshot_driver")) {
          snapshot_id = parsed_snapshot_id.get("snapshot_id");
          snapshot_driver = parsed_snapshot_id.get("snapshot_driver");
        } else {
          snapshot_driver = "xfs-reflink";
        }
      }

      switch (volume_content_source.type) {
        case "snapshot":
          if (snapshot_driver === "xfs-reflink") {
            source_path = driver.getControllerSnapshotPath(snapshot_id);
            if (!(await driver.directoryExists(source_path))) {
              throw new Error(
                `invalid volume_content_source path: ${source_path}`
              );
            }
            await driver.assertSameXfsFilesystem(source_path, volume_path);
            await driver.reflinkCopy(source_path, volume_path);
          } else {
            // fall through to base class logic for other snapshot drivers
            return super.CreateVolume(call);
          }
          break;
        case "volume":
          source_path = driver.getControllerVolumePath(
            volume_content_source.volume.volume_id
          );
          if (!(await driver.directoryExists(source_path))) {
            throw new Error(
              `invalid volume_content_source path: ${source_path}`
            );
          }
          await driver.assertSameXfsFilesystem(source_path, volume_path);
          await driver.reflinkCopy(source_path, volume_path);
          break;
        default:
          throw new Error(
            `invalid volume_content_source type: ${volume_content_source.type}`
          );
      }
    }

    // set dir permissions
    if (this.options[configKey].dirPermissionsMode) {
      driver.ctx.logger.verbose(
        "setting dir mode to: %s on dir: %s",
        this.options[configKey].dirPermissionsMode,
        volume_path
      );
      fs.chmodSync(volume_path, this.options[configKey].dirPermissionsMode);
    }

    if (
      this.options[configKey].dirPermissionsUser ||
      this.options[configKey].dirPermissionsGroup
    ) {
      driver.ctx.logger.verbose(
        "setting ownership to: %s:%s on dir: %s",
        this.options[configKey].dirPermissionsUser,
        this.options[configKey].dirPermissionsGroup,
        volume_path
      );
      if (!driver.getNodeIsWindows()) {
        await driver.exec("chown", [
          (this.options[configKey].dirPermissionsUser
            ? this.options[configKey].dirPermissionsUser
            : "") +
            ":" +
            (this.options[configKey].dirPermissionsGroup
              ? this.options[configKey].dirPermissionsGroup
              : ""),
          volume_path,
        ]);
      }
    }

    // apply XFS project quota (only for new volumes, not from snapshot)
    if (!volume_content_source || volume_content_source.type !== "snapshot") {
      await driver.setXfsProjectQuota(volume_path, capacity_bytes);
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
        capacity_bytes: 0,
        content_source: volume_content_source,
        volume_context,
        accessible_topology,
      },
    };

    return res;
  }

  /**
   * Override DeleteVolume to clear project quota before removing directory.
   */
  async DeleteVolume(call) {
    const driver = this;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new Error(`volume_id is required`);
    }

    // deleteStrategy
    const delete_strategy = _.get(
      driver.options,
      "_private.csi.volume.deleteStrategy",
      ""
    );

    if (delete_strategy === "retain") {
      return {};
    }

    const volume_path = driver.getControllerVolumePath(volume_id);

    // clear XFS project quota before deleting
    try {
      await driver.clearXfsProjectQuota(volume_path);
    } catch (err) {
      driver.ctx.logger.warn(
        `failed to clear XFS quota for ${volume_path}: ${err.message}`
      );
    }

    await driver.deleteDir(volume_path);

    return {};
  }

  /**
   * ControllerExpandVolume: adjust the XFS project quota for the volume.
   */
  async ControllerExpandVolume(call) {
    const driver = this;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new Error(`volume_id is required`);
    }

    const capacity_range = call.request.capacity_range || {};
    const required_bytes = capacity_range.required_bytes;

    if (!required_bytes || required_bytes <= 0) {
      throw new Error(`required_bytes must be positive`);
    }

    const volume_path = driver.getControllerVolumePath(volume_id);

    // verify the volume still exists
    if (!(await driver.directoryExists(volume_path))) {
      throw new Error(`volume path not found: ${volume_path}`);
    }

    // adjust the XFS project quota
    await driver.setXfsProjectQuota(volume_path, required_bytes);

    return {
      capacity_bytes: required_bytes,
    };
  }

  /**
   * Override CreateSnapshot to use xfs-reflink instead of filecopy/restic/kopia.
   */
  async CreateSnapshot(call) {
    const driver = this;

    const configKey = driver.getConfigKey();

    // both source_volume_id and name are required
    const source_volume_id = call.request.source_volume_id;
    let name = call.request.name;

    if (!source_volume_id) {
      throw new Error(`snapshot source_volume_id is required`);
    }

    if (!name) {
      throw new Error(`snapshot name is required`);
    }

    // sanitize name
    name = name.replace(/[^a-z0-9_\-:.+]+/gi, "");

    const volume_path = driver.getControllerVolumePath(source_volume_id);
    const snapshot_id = `${source_volume_id}-${name}`;
    const snapshot_path = driver.getControllerSnapshotPath(snapshot_id);

    // verify source is on XFS
    try {
      await driver.assertXfs(volume_path);
    } catch (err) {
      throw new Error(
        `CreateSnapshot failed XFS check for ${volume_path}: ${err.message}`
      );
    }

    const snapshot_dir_exists = await driver.directoryExists(snapshot_path);
    if (!snapshot_dir_exists) {
      await driver.createDir(snapshot_path);

      // verify destination is on XFS
      try {
        await driver.assertXfs(snapshot_path);
      } catch (err) {
        throw new Error(
          `CreateSnapshot failed XFS check for ${snapshot_path}: ${err.message}`
        );
      }

      // verify same filesystem
      try {
        await driver.assertSameXfsFilesystem(volume_path, snapshot_path);
      } catch (err) {
        throw new Error(err.message);
      }

      // cut the reflink snapshot
      await driver.reflinkCopy(volume_path, snapshot_path);
      driver.ctx.logger.info(
        `xfs-reflink snapshot finished: snapshot_id=${snapshot_id}, path=${volume_path}`
      );
    } else {
      driver.ctx.logger.debug(
        `xfs-reflink snapshot already cut: ${snapshot_id}`
      );
    }

    const size_bytes = await driver.getDirectoryUsage(snapshot_path);

    return {
      snapshot: {
        size_bytes,
        snapshot_id: new URLSearchParams({
          snapshot_driver: "xfs-reflink",
          snapshot_id,
        }).toString(),
        source_volume_id: source_volume_id,
        creation_time: {
          seconds: Math.round(new Date().getTime() / 1000),
          nanos: 0,
        },
        ready_to_use: true,
      },
    };
  }

  /**
   * Override DeleteSnapshot to remove the snapshot directory.
   */
  async DeleteSnapshot(call) {
    const driver = this;

    let snapshot_id = call.request.snapshot_id;
    if (!snapshot_id) {
      throw new Error(`snapshot_id is required`);
    }

    // parse out the actual snapshot_id from URLSearchParams format
    const parsed_snapshot_id = new URLSearchParams(snapshot_id);
    if (parsed_snapshot_id.get("snapshot_id")) {
      snapshot_id = parsed_snapshot_id.get("snapshot_id");
    }

    const snapshot_path = driver.getControllerSnapshotPath(snapshot_id);
    await driver.deleteDir(snapshot_path);

    return {};
  }
}

module.exports.ControllerLocalXfsHostpathDriver =
  ControllerLocalXfsHostpathDriver;
