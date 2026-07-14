const _ = require("lodash");
const fs = require("fs");
const cp = require("child_process");

const { ControllerClientCommonDriver } = require("../controller-client-common");

const NODE_TOPOLOGY_KEY_NAME = "org.democratic-csi.topology/node";

const XFS_PROJECT_ID_FILE = ".csi-xfs-project-id";

/**
 * xfs-local-hostpath driver: same structure as local-hostpath but with
 * XFS-specific behaviours layered on top:
 *  - filesystem verification (XFS only) at startup and on every volume op
 *  - per-PVC XFS project-quota enforcement via xfs_quota(8)
 *  - CoW reflink snapshots instead of rsync/restic/kopia
 *
 * Volume expansion is node-only: the authoritative resize happens in
 * NodeExpandVolume which runs `xfs_quota` to update project quotas.  There
 * is no ControllerExpandVolume because this driver is node-local by nature —
 * a controller-side RPC cannot change storage on an arbitrary node.
 */
class ControllerXfsLocalHostpathDriver extends ControllerClientCommonDriver {
  constructor(ctx, options) {
    const i_caps = _.get(
      options,
      "service.identity.capabilities.service",
      false
    );

    const c_caps = _.get(options, "service.controller.capabilities", false);
    super(...arguments);

    if (!i_caps) {
      this.ctx.logger.debug("setting xfs-local-hostpath identity service caps");

      options.service.identity.capabilities.service = [
        "CONTROLLER_SERVICE",
        "VOLUME_ACCESSIBILITY_CONSTRAINTS",
      ];
    }

    if (!c_caps) {
      this.ctx.logger.debug(
        "setting xfs-local-hostpath controller service caps"
      );

      // GET_CAPACITY is useful for reporting available space on the host path.
      // EXPAND_VOLUME is intentionally NOT advertised here — expansion is
      // handled exclusively by NodeExpandVolume (see below).  Kubernetes
      // kubelet will call NodeExpandVolume after a PVC resize + pod restart;
      // no external-resizer sidecar is needed or expected for this driver.
      if (
        !options.service.controller.capabilities.rpc.includes("GET_CAPACITY")
      ) {
        options.service.controller.capabilities.rpc.push("GET_CAPACITY");
      }
    }

    if (
      !options.service.node.capabilities.rpc ||
      options.service.node.capabilities.rpc.length === 0
    ) {
      this.ctx.logger.debug("setting xfs-local-hostpath node service caps");

      options.service.node.capabilities.rpc = [
        "STAGE_UNSTAGE_VOLUME",
        "GET_VOLUME_STATS",
        "EXPAND_VOLUME",
      ];
    } else if (
      !options.service.node.capabilities.rpc.includes("EXPAND_VOLUME")
    ) {
      options.service.node.capabilities.rpc.push("EXPAND_VOLUME");
    }

    // Advertise ONLINE expansion so kubelet's resize handler knows this
    // driver can expand volumes while they are published to a node.
    if (
      !options.service.identity.capabilities.volume_expansion ||
      options.service.identity.capabilities.volume_expansion.length === 0
    ) {
      this.ctx.logger.debug(
        "setting xfs-local-hostpath identity volume_expansion caps"
      );

      options.service.identity.capabilities.volume_expansion = ["ONLINE"];
    }
  }

  getConfigKey() {
    return "xfs-local-hostpath";
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
   * volume directory so NodeExpandVolume and re-apply are idempotent.
   *
   * @param {string} volumePath - absolute path to the volume directory
   * @param {number|string} bytes - quota size in bytes
   * @returns {Promise<number>} project ID
   */
  async setXfsProjectQuota(volumePath, bytes) {
    const driver = this;
    const mountpoint = driver.getControllerBasePath();

    let projId = driver._readXfsProjectIdFile(volumePath).projId;
    if (!projId) {
      // derive deterministically from volume_id (stored as basename of volumePath)
      const volumeId = driver._extractVolumeIdFromPath(volumePath);
      projId = driver._deriveProjectId(volumeId);
      driver._writeXfsProjectIdFile(volumePath, projId, bytes);
    }

    // project -s binds the project to the directory (idempotent)
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

    // persist the quota bytes alongside the project ID so NodeExpandVolume
    // and node-side re-apply both have a source of truth even after the
    // volume_context is no longer in play
    driver._writeXfsProjectIdFile(volumePath, projId, bytes);

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
    const mountpoint = driver.getControllerBasePath();

    const xfsProjInfo = driver._readXfsProjectIdFile(volumePath);
    let projId = xfsProjInfo.projId;
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

    /**
     * Remove any inherited .csi-xfs-project-id sidecar file from the source.
     */
    try {
      const sidecarPath = dst + "/" + XFS_PROJECT_ID_FILE;
      fs.unlinkSync(sidecarPath);
    } catch (e) {
      // ignore — source may not have a sidecar file (snapshots, old volumes)
    }

    /**
     * Clear all inherited XFS quotas for the new PVC directory.
     * `cp --archive` preserves the inode's project ID (projid) from the source,
     * so both directories would share the same quota entry unless we reset it.
     * This must happen before old quota project IDs are removed to ensure the
     * cloned volume gets a fresh independent quota on the next setXfsProjectQuota call.
     */
    try {
      await driver.clearInheritedXfsQuota(dst);
    } catch (err) {
      driver.ctx.logger.warn(
        `failed to clear inherited XFS quotas for ${dst}: ${err.message}`
      );
    }
  }

  /**
   * Clear all XFS project quota mappings and the inode's projid for a directory.
   * Removes any entries in /etc/xfs/projectid2path pointing at this path, then
   * resets the inode's project ID to 0 (unrestricted).
   *
   * @param {string} volumePath - absolute path to the volume directory
   */
  async clearInheritedXfsQuota(volumePath) {
    const driver = this;
    const mountpoint = driver.getControllerBasePath();

    // Remove all project-to-path mappings that reference this directory.
    // xfs_quota "project -d" deletes a path from the projectid2path mapping.
    try {
      await driver.exec("xfs_quota", [
        "-x",
        "-c",
        `project -d -p ${volumePath}`,
        mountpoint,
      ]);
    } catch (err) {
      // Path may not be registered in any project mapping — ignore.
      driver.ctx.logger.debug(
        `no project mapping to remove for ${volumePath}: ${err.message}`
      );
    }

    // Reset the inode's XFS project ID back to 0 so it no longer inherits
    // quota from the source directory after cp --archive preserved projid.
    try {
      await driver.exec("xfs_quota", [
        "-x",
        "-c",
        `chprojid ${volumePath} 0`,
        mountpoint,
      ]);
    } catch (err) {
      // chprojid may fail if the filesystem was not mounted with prjquota or
      // if xfs_quota does not support it — best effort.
      driver.ctx.logger.debug(
        `could not reset projid to 0 for ${volumePath}: ${err.message}`
      );
    }

    driver.ctx.logger.info(
      `cleared inherited XFS quotas for path=${volumePath}`
    );
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
   * Read the persisted sidecar file. Returns { projId, quotaBytes }.
   * Format is two lines: project_id on line 1, quota_bytes on line 2 (optional
   * for backward compatibility with volumes created before quota persistence).
   */
  _readXfsProjectIdFile(volumePath) {
    try {
      const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
      if (fs.existsSync(idFilePath)) {
        const content = fs.readFileSync(idFilePath, "utf8").trim();
        const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
        const projId = lines[0] ? parseInt(lines[0], 10) : null;
        const quotaBytes =
          lines.length > 1 && lines[1]
            ? parseInt(lines[1], 10)
            : null;
        return { projId: isNaN(projId) ? null : projId, quotaBytes };
      }
    } catch (e) {
      // ignore
    }
    return { projId: null, quotaBytes: null };
  }

  /**
   * Write the project ID and quota bytes to the sidecar file.
   */
  _writeXfsProjectIdFile(volumePath, projId, quotaBytes) {
    const idFilePath = volumePath + "/" + XFS_PROJECT_ID_FILE;
    const lines = [String(projId)];
    if (quotaBytes !== undefined && quotaBytes !== null) {
      lines.push(String(quotaBytes));
    }
    fs.writeFileSync(idFilePath, lines.join("\n") + "\n", { mode: "0644" });
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
            await driver.setXfsProjectQuota(volume_path, capacity_bytes);
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
          await driver.setXfsProjectQuota(volume_path, capacity_bytes);
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

    // apply XFS project quota for new volumes (clones get it after reflinkCopy)
    if (!volume_content_source) {
      await driver.setXfsProjectQuota(volume_path, capacity_bytes);
    }

    let volume_context = driver.getVolumeContext(volume_id);

    volume_context["provisioner_driver"] = driver.options.driver;
    if (driver.options.instance_id) {
      volume_context["provisioner_driver_instance_id"] =
        driver.options.instance_id;
    }

    // pass quota bytes through volume_context so the node side can re-apply
    // the XFS project quota on every mount (needed for clones from reflink
    // snapshots, which do not carry quota)
    volume_context["xfs_quota_bytes"] = capacity_bytes;

    let accessible_topology;
    if (typeof this.getAccessibleTopology === "function") {
      accessible_topology = await this.getAccessibleTopology();
    }

    const res = {
      volume: {
        volume_id,
        capacity_bytes: capacity_bytes,
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
   * NodeExpandVolume: set the XFS project quota on this node's volume dir.
   *
   * This is the only expansion RPC for xfs-local-hostpath.  Because volumes
   * are stored locally on each node, a controller-side expand would be
   * meaningless — it could not reach the backing directory on an arbitrary
   * other node.  Instead kubelet calls NodeExpandVolume after a PVC resize +
   * pod restart (or when the external-resizer triggers it).
   *
   * The new quota is read from the sidecar file (which was updated by
   * CreateVolume or a prior expansion); if absent we fall back to the
   * requested capacity_bytes.  Either way `xfs_quota` writes the updated
   * limit so the next mount picks it up automatically.
   */
  async NodeExpandVolume(call) {
    const driver = this;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new Error(`volume_id is required`);
    }

    const volume_path = call.request.volume_path;
    if (!volume_path) {
      throw new Error(`volume_path is required`);
    }

    const capacity_range = call.request.capacity_range || {};
    let requestedBytes =
      capacity_range.required_bytes || capacity_range.limit_bytes;
    if (!requestedBytes || requestedBytes <= 0) {
      throw new Error(
        `capacity_range.required_bytes or limit_bytes must be provided`
      );
    }

    // Determine the XFS mountpoint containing the volume directory so that
    // xfs_quota targets the correct filesystem.
    let mountpoint;
    try {
      const result = await driver.exec("findmnt", [
        "-n",
        "-o",
        "TARGET",
        "--target",
        volume_path,
      ]);
      mountpoint = result.stdout.trim();
    } catch (err) {
      throw new Error(
        `failed to determine XFS mountpoint for ${volume_path}: ${err.message}`
      );
    }

    if (!mountpoint) {
      throw new Error(
        `could not find mountpoint for volume_path ${volume_path}`
      );
    }

    // Read the persisted sidecar file to get (or derive) the project ID.
    let projId;
    try {
      const info = driver._readXfsProjectIdFile(volume_path);
      if (info.projId) {
        projId = info.projId;
      } else {
        // No sidecar yet — derive one deterministically from volume_id.
        // This can happen for freshly-expanded volumes before the next
        // CreateVolume/NodeExpandVolume cycle rewrites it.
        const volId = driver._extractVolumeIdFromPath(volume_path);
        projId = driver._deriveProjectId(volId);

        // Persist so subsequent mounts / expansions don't need to derive again.
        driver._writeXfsProjectIdFile(volume_path, projId, requestedBytes);
      }
    } catch (err) {
      throw new Error(
        `failed to read project ID for ${volume_path}: ${err.message}`
      );
    }

    // Apply the updated quota limit.  xfs_quota handles growing/shrinking
    // freely; bsoft === bhard means no grace period — writes are blocked
    // once the hard limit is reached.
    await driver.exec("xfs_quota", [
      "-x",
      "-c",
      `limit -p bsoft=${requestedBytes} bhard=${requestedBytes} ${projId}`,
      mountpoint,
    ]);

    // Also re-bind the project to the directory (idempotent; required when
    // the volume was created before xfs_quota "project" tracking started).
    await driver.exec("xfs_quota", [
      "-x",
      "-c",
      `project -s -p ${volume_path} ${projId}`,
      mountpoint,
    ]);

    driver.ctx.logger.info(
      `node expanded XFS project quota projid=${projId} bytes=${requestedBytes} on path=${volume_path}`
    );

    return { capacity_bytes: requestedBytes };
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

module.exports.ControllerXfsLocalHostpathDriver =
  ControllerXfsLocalHostpathDriver;
