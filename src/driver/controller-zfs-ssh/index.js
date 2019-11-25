const grpc = require("grpc");
const { CsiBaseDriver } = require("../index");
const SshClient = require("../../utils/ssh").SshClient;
const { GrpcError } = require("../../utils/grpc");

const { Zetabyte, ZfsSshProcessManager } = require("../../utils/zfs");

// zfs common properties
const MANAGED_PROPERTY_NAME = "democratic-csi:managed_resource";
const SUCCESS_PROPERTY_NAME = "democratic-csi:provision_success";
const VOLUME_SOURCE_CLONE_SNAPSHOT_PREFIX = "volume-source-for-volume-";
const VOLUME_SOURCE_DETACHED_SNAPSHOT_PREFIX = "volume-source-for-snapshot-";
const VOLUME_CSI_NAME_PROPERTY_NAME = "democratic-csi:csi_volume_name";
const SHARE_VOLUME_CONTEXT_PROPERTY_NAME =
  "democratic-csi:csi_share_volume_context";
const VOLUME_CONTENT_SOURCE_TYPE_PROPERTY_NAME =
  "democratic-csi:csi_volume_content_source_type";
const VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME =
  "democratic-csi:csi_volume_content_source_id";
const SNAPSHOT_CSI_NAME_PROPERTY_NAME = "democratic-csi:csi_snapshot_name";
const SNAPSHOT_CSI_SOURCE_VOLUME_ID_PROPERTY_NAME =
  "democratic-csi:csi_snapshot_source_volume_id";

/**
 * Base driver to provisin zfs assets over ssh.
 * Derived drivers only need to implement:
 *  - getDriverZfsResourceType() // return "filesystem" or "volume"
 *  - async createShare(call, datasetName) // return appropriate volume_context for Node operations
 *  - async deleteShare(call, datasetName) // no return expected
 *  - async expandVolume(call, datasetName) // no return expected, used for restarting services etc if needed
 */
class ControllerZfsSshBaseDriver extends CsiBaseDriver {
  constructor(ctx, options) {
    super(...arguments);

    options.service.identity.capabilities =
      options.service.identity.capabilities || {};

    options.service.controller.capabilities =
      options.service.controller.capabilities || {};

    options.service.node.capabilities = options.service.node.capabilities || {};

    if (!("service" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity service caps");

      options.service.identity.capabilities.service = [
        //"UNKNOWN",
        "CONTROLLER_SERVICE"
        //"VOLUME_ACCESSIBILITY_CONSTRAINTS"
      ];
    }

    if (!("volume_expansion" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity volume_expansion caps");

      options.service.identity.capabilities.volume_expansion = [
        //"UNKNOWN",
        "ONLINE"
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
        "GET_CAPACITY",
        "CREATE_DELETE_SNAPSHOT",
        "LIST_SNAPSHOTS",
        "CLONE_VOLUME",
        //"PUBLISH_READONLY",
        "EXPAND_VOLUME"
      ];
    }

    if (!("rpc" in options.service.node.capabilities)) {
      this.ctx.logger.debug("setting default node caps");

      switch (this.getDriverZfsResourceType()) {
        case "filesystem":
          options.service.node.capabilities.rpc = [
            //"UNKNOWN",
            "STAGE_UNSTAGE_VOLUME",
            "GET_VOLUME_STATS"
            //"EXPAND_VOLUME"
          ];
          break;
        case "volume":
          options.service.node.capabilities.rpc = [
            //"UNKNOWN",
            "STAGE_UNSTAGE_VOLUME",
            "GET_VOLUME_STATS",
            "EXPAND_VOLUME"
          ];
          break;
      }
    }
  }

  getSshClient() {
    return new SshClient({
      logger: this.ctx.logger,
      connection: this.options.sshConnection
    });
  }

  getZetabyte() {
    const sshClient = this.getSshClient();
    return new Zetabyte({
      executor: new ZfsSshProcessManager(sshClient),
      idempotent: true
    });
  }

  getDatasetParentName() {
    let datasetParentName = this.options.zfs.datasetParentName;
    datasetParentName = datasetParentName.replace(/\/$/, "");
    return datasetParentName;
  }

  getVolumeParentDatasetName() {
    let datasetParentName = this.getDatasetParentName();
    //datasetParentName += "/v";
    datasetParentName = datasetParentName.replace(/\/$/, "");
    return datasetParentName;
  }

  getDetachedSnapshotParentDatasetName() {
    //let datasetParentName = this.getDatasetParentName();
    let datasetParentName = this.options.zfs.detachedSnapshotsDatasetParentName;
    //datasetParentName += "/s";
    datasetParentName = datasetParentName.replace(/\/$/, "");
    return datasetParentName;
  }

  async removeSnapshotsFromDatatset(datasetName, options = {}) {
    const zb = this.getZetabyte();

    await zb.zfs.destroy(datasetName + "@%", options);
  }

  assertCapabilities(capabilities) {
    const driverZfsResourceType = this.getDriverZfsResourceType();
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
    const valid = capabilities.every(capability => {
      switch (driverZfsResourceType) {
        case "filesystem":
          if (capability.access_type != "mount") {
            message = `invalid access_type ${capability.access_type}`;
            return false;
          }

          if (
            capability.mount.fs_type &&
            !["nfs"].includes(capability.mount.fs_type)
          ) {
            message = `invalid fs_type ${capability.mount.fs_type}`;
            return false;
          }

          if (
            ![
              "UNKNOWN",
              "SINGLE_NODE_WRITER",
              "SINGLE_NODE_READER_ONLY",
              "MULTI_NODE_READER_ONLY",
              "MULTI_NODE_SINGLE_WRITER",
              "MULTI_NODE_MULTI_WRITER"
            ].includes(capability.access_mode.mode)
          ) {
            message = `invalid access_mode, ${capability.access_mode.mode}`;
            return false;
          }

          return true;
        case "volume":
          if (capability.access_type == "mount") {
            if (
              capability.mount.fs_type &&
              !["ext3", "ext4", "ext4dev", "xfs"].includes(
                capability.mount.fs_type
              )
            ) {
              message = `invalid fs_type ${capability.mount.fs_type}`;
              return false;
            }
          }

          if (
            ![
              "UNKNOWN",
              "SINGLE_NODE_WRITER",
              "SINGLE_NODE_READER_ONLY",
              "MULTI_NODE_READER_ONLY",
              "MULTI_NODE_SINGLE_WRITER"
            ].includes(capability.access_mode.mode)
          ) {
            message = `invalid access_mode, ${capability.access_mode.mode}`;
            return false;
          }

          return true;
      }
    });

    return { valid, message };
  }

  /**
   * Create a volume doing in essence the following:
   * 1. create dataset
   * 2. create nfs share
   *
   * Should return 2 parameters
   * 1. `server` - host/ip of the nfs server
   * 2. `share` - path of the mount shared
   *
   * @param {*} call
   */
  async CreateVolume(call) {
    const driver = this;
    const driverZfsResourceType = this.getDriverZfsResourceType();
    const sshClient = this.getSshClient();
    const zb = this.getZetabyte();

    let datasetParentName = this.getVolumeParentDatasetName();
    let snapshotParentDatasetName = this.getDetachedSnapshotParentDatasetName();
    let zvolBlocksize = this.options.zfs.zvolBlocksize || "16K";
    let name = call.request.name;
    let volume_content_source = call.request.volume_content_source;

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    if (!name) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume name is required`
      );
    }

    if (call.request.volume_capabilities) {
      const result = this.assertCapabilities(call.request.volume_capabilities);
      if (result.valid !== true) {
        throw new GrpcError(grpc.status.INVALID_ARGUMENT, result.message);
      }
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

    const datasetName = datasetParentName + "/" + name;
    let capacity_bytes =
      call.request.capacity_range.required_bytes ||
      call.request.capacity_range.limit_bytes;

    if (capacity_bytes && driverZfsResourceType == "volume") {
      //make sure to align capacity_bytes with zvol blocksize
      //volume size must be a multiple of volume block size
      capacity_bytes = zb.helpers.generateZvolSize(
        capacity_bytes,
        zvolBlocksize
      );
    }
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

    /**
     * This is specifically a FreeBSD limitation, not sure what linux limit is
     * https://www.ixsystems.com/documentation/freenas/11.2-U5/storage.html#zfs-zvol-config-opts-tab
     * https://www.ixsystems.com/documentation/freenas/11.3-BETA1/intro.html#path-and-name-lengths
     * https://www.freebsd.org/cgi/man.cgi?query=devfs
     */
    if (driverZfsResourceType == "volume") {
      let extentDiskName = "zvol/" + datasetName;
      if (extentDiskName.length > 63) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `extent disk name cannot exceed 63 characters:  ${extentDiskName}`
        );
      }
    }

    let response, command;
    let volume_content_source_snapshot_id;
    let volume_content_source_volume_id;
    let fullSnapshotName;
    let volumeProperties = {};
    volumeProperties[VOLUME_CSI_NAME_PROPERTY_NAME] = name;
    volumeProperties[MANAGED_PROPERTY_NAME] = "true";

    // TODO: also set access_mode as property?
    // TODO: also set fsType as property?
    // TODO: allow for users to configure arbitrary/custom properties to add

    // zvol enables reservation by default
    // this implements 'sparse' zvols
    if (driverZfsResourceType == "volume") {
      if (!this.options.zfs.zvolEnableReservation) {
        volumeProperties.refreservation = 0;
      }
    }

    let detachedClone = false;

    // create dataset
    if (volume_content_source) {
      volumeProperties[VOLUME_CONTENT_SOURCE_TYPE_PROPERTY_NAME] =
        volume_content_source.type;
      switch (volume_content_source.type) {
        // must be available when adverstising CREATE_DELETE_SNAPSHOT
        // simply clone
        case "snapshot":
          try {
            let tmpDetachedClone = JSON.parse(
              driver.getNormalizedParameterValue(
                call.request.parameters,
                "detachedVolumesFromSnapshots"
              )
            );
            if (typeof tmpDetachedClone === "boolean") {
              detachedClone = tmpDetachedClone;
            }
          } catch (e) {}

          volumeProperties[VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME] =
            volume_content_source.snapshot.snapshot_id;
          volume_content_source_snapshot_id =
            volume_content_source.snapshot.snapshot_id;

          // zfs origin property contains parent info, ie: pool0/k8s/test/PVC-111@clone-test
          if (zb.helpers.isZfsSnapshot(volume_content_source_snapshot_id)) {
            fullSnapshotName =
              datasetParentName + "/" + volume_content_source_snapshot_id;
          } else {
            fullSnapshotName =
              snapshotParentDatasetName +
              "/" +
              volume_content_source_snapshot_id +
              "@" +
              VOLUME_SOURCE_CLONE_SNAPSHOT_PREFIX +
              name;
          }

          driver.ctx.logger.debug("full snapshot name: %s", fullSnapshotName);

          if (!zb.helpers.isZfsSnapshot(volume_content_source_snapshot_id)) {
            try {
              await zb.zfs.snapshot(fullSnapshotName);
            } catch (err) {
              if (err.toString().includes("dataset does not exist")) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  `snapshot source_snapshot_id ${volume_content_source_snapshot_id} does not exist`
                );
              }

              throw err;
            }
          }

          if (detachedClone) {
            try {
              response = await zb.zfs.send_receive(
                fullSnapshotName,
                [],
                datasetName,
                []
              );

              response = await zb.zfs.set(datasetName, volumeProperties);
            } catch (err) {
              if (
                err.toString().includes("destination") &&
                err.toString().includes("exists")
              ) {
                // move along
              } else {
                throw err;
              }
            }

            // remove snapshots from target
            await this.removeSnapshotsFromDatatset(datasetName, {
              force: true
            });
          } else {
            try {
              response = await zb.zfs.clone(fullSnapshotName, datasetName, {
                properties: volumeProperties
              });
            } catch (err) {
              if (err.toString().includes("dataset does not exist")) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  "dataset does not exists"
                );
              }

              throw err;
            }
          }

          if (!zb.helpers.isZfsSnapshot(volume_content_source_snapshot_id)) {
            try {
              // schedule snapshot removal from source
              await zb.zfs.destroy(fullSnapshotName, {
                recurse: true,
                force: true,
                defer: true
              });
            } catch (err) {
              if (err.toString().includes("dataset does not exist")) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  `snapshot source_snapshot_id ${volume_content_source_snapshot_id} does not exist`
                );
              }

              throw err;
            }
          }

          break;
        // must be available when adverstising CLONE_VOLUME
        // create snapshot first, then clone
        case "volume":
          try {
            let tmpDetachedClone = JSON.parse(
              driver.getNormalizedParameterValue(
                call.request.parameters,
                "detachedVolumesFromVolumes"
              )
            );
            if (typeof tmpDetachedClone === "boolean") {
              detachedClone = tmpDetachedClone;
            }
          } catch (e) {}

          volumeProperties[VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME] =
            volume_content_source.volume.volume_id;
          volume_content_source_volume_id =
            volume_content_source.volume.volume_id;

          fullSnapshotName =
            datasetParentName +
            "/" +
            volume_content_source_volume_id +
            "@" +
            VOLUME_SOURCE_CLONE_SNAPSHOT_PREFIX +
            name;

          driver.ctx.logger.debug("full snapshot name: %s", fullSnapshotName);

          // create snapshot
          try {
            response = await zb.zfs.snapshot(fullSnapshotName);
          } catch (err) {
            if (err.toString().includes("dataset does not exist")) {
              throw new GrpcError(
                grpc.status.FAILED_PRECONDITION,
                "dataset does not exists"
              );
            }

            throw err;
          }

          if (detachedClone) {
            try {
              response = await zb.zfs.send_receive(
                fullSnapshotName,
                [],
                datasetName,
                []
              );
            } catch (err) {
              if (
                err.toString().includes("destination") &&
                err.toString().includes("exists")
              ) {
                // move along
              } else {
                throw err;
              }
            }

            response = await zb.zfs.set(datasetName, volumeProperties);

            // remove snapshots from target
            await this.removeSnapshotsFromDatatset(datasetName, {
              force: true
            });

            // remove snapshot from source
            await zb.zfs.destroy(fullSnapshotName, {
              recurse: true,
              force: true,
              defer: true
            });
          } else {
            // create clone
            // zfs origin property contains parent info, ie: pool0/k8s/test/PVC-111@clone-test
            try {
              response = await zb.zfs.clone(fullSnapshotName, datasetName, {
                properties: volumeProperties
              });
            } catch (err) {
              if (err.toString().includes("dataset does not exist")) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  "dataset does not exists"
                );
              }

              throw err;
            }
          }
          break;
        default:
          throw new GrpcError(
            grpc.status.INVALID_ARGUMENT,
            `invalid volume_content_source type: ${volume_content_source.type}`
          );
          break;
      }
    } else {
      // force blocksize on newly created zvols
      if (driverZfsResourceType == "volume") {
        volumeProperties.volblocksize = zvolBlocksize;
      }

      await zb.zfs.create(datasetName, {
        parents: true,
        properties: volumeProperties,
        size: driverZfsResourceType == "volume" ? capacity_bytes : false
      });
    }

    let setProps = false;
    let properties = {};
    let volume_context = {};

    switch (driverZfsResourceType) {
      case "filesystem":
        // set quota
        if (this.options.zfs.datasetEnableQuotas) {
          setProps = true;
          properties.refquota = capacity_bytes;
        }

        // set reserve
        if (this.options.zfs.datasetEnableReservation) {
          setProps = true;
          properties.refreservation = capacity_bytes;
        }

        // quota for dataset and all children
        // reserved for dataset and all children

        // dedup
        // ro?
        // record size

        // set properties
        if (setProps) {
          await zb.zfs.set(datasetName, properties);
        }

        //datasetPermissionsMode: 0777,
        //datasetPermissionsUser: "root",
        //datasetPermissionsGroup: "wheel",

        // get properties needed for remaining calls
        properties = await zb.zfs.get(datasetName, [
          "mountpoint",
          "refquota",
          "compression",
          VOLUME_CSI_NAME_PROPERTY_NAME,
          VOLUME_CONTENT_SOURCE_TYPE_PROPERTY_NAME,
          VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME
        ]);
        properties = properties[datasetName];
        driver.ctx.logger.debug("zfs props data: %j", properties);

        // set mode
        if (this.options.zfs.datasetPermissionsMode) {
          command = sshClient.buildCommand("chmod", [
            this.options.zfs.datasetPermissionsMode,
            properties.mountpoint.value
          ]);
          driver.ctx.logger.verbose("set permission command: %s", command);
          response = await sshClient.exec(command);
        }

        // set ownership
        if (
          this.options.zfs.datasetPermissionsUser ||
          this.options.zfs.datasetPermissionsGroup
        ) {
          command = sshClient.buildCommand("chown", [
            (this.options.zfs.datasetPermissionsUser
              ? this.options.zfs.datasetPermissionsUser
              : "") +
              ":" +
              (this.options.zfs.datasetPermissionsGroup
                ? this.options.zfs.datasetPermissionsGroup
                : ""),
            properties.mountpoint.value
          ]);
          driver.ctx.logger.verbose("set ownership command: %s", command);
          response = await sshClient.exec(command);
        }

        break;
      case "volume":
        // TODO: create all the necessary iscsi stuff
        // set properties
        // set reserve
        setProps = true;

        // this should be already set, but when coming from a volume source
        // it may not match that of the source
        // TODO: probably need to recalculate size based on *actual* volume source blocksize in case of difference from currently configured
        properties.volsize = capacity_bytes;

        //dedup
        //compression

        if (setProps) {
          await zb.zfs.set(datasetName, properties);
        }

        break;
    }

    volume_context = await this.createShare(call, datasetName);
    await zb.zfs.set(datasetName, {
      [SHARE_VOLUME_CONTEXT_PROPERTY_NAME]:
        "'" + JSON.stringify(volume_context) + "'"
    });

    // set this just before sending out response so we know if volume completed
    // this should give us a relatively sane way to clean up artifacts over time
    await zb.zfs.set(datasetName, { [SUCCESS_PROPERTY_NAME]: "true" });

    const res = {
      volume: {
        volume_id: name,
        capacity_bytes: this.options.zfs.datasetEnableQuotas
          ? capacity_bytes
          : 0,
        content_source: volume_content_source,
        volume_context
      }
    };

    return res;
  }

  /**
   * Delete a volume
   *
   * Deleting a volume consists of the following steps:
   * 1. delete the nfs share
   * 2. delete the dataset
   *
   * @param {*} call
   */
  async DeleteVolume(call) {
    const driver = this;
    const zb = this.getZetabyte();

    let datasetParentName = this.getVolumeParentDatasetName();
    let name = call.request.volume_id;

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    if (!name) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    const datasetName = datasetParentName + "/" + name;
    let properties;

    // get properties needed for remaining calls
    try {
      properties = await zb.zfs.get(datasetName, [
        "mountpoint",
        "origin",
        "refquota",
        "compression",
        VOLUME_CSI_NAME_PROPERTY_NAME
      ]);
      properties = properties[datasetName];
    } catch (err) {
      let ignore = false;
      if (err.toString().includes("dataset does not exist")) {
        ignore = true;
      }

      if (!ignore) {
        throw err;
      }
    }

    driver.ctx.logger.debug("dataset properties: %j", properties);

    // remove share resources
    await this.deleteShare(call, datasetName);

    // remove parent snapshot if appropriate with defer
    if (
      properties &&
      properties.origin &&
      properties.origin.value != "-" &&
      zb.helpers
        .extractSnapshotName(properties.origin.value)
        .startsWith(VOLUME_SOURCE_CLONE_SNAPSHOT_PREFIX)
    ) {
      driver.ctx.logger.debug(
        "removing with defer source snapshot: %s",
        properties.origin.value
      );

      try {
        await zb.zfs.destroy(properties.origin.value, {
          recurse: true,
          force: true,
          defer: true
        });
      } catch (err) {
        if (err.toString().includes("snapshot has dependent clones")) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            "snapshot has dependent clones"
          );
        }
        throw err;
      }
    }

    // NOTE: -f does NOT allow deletes if dependent filesets exist
    // NOTE: -R will recursively delete items + dependent filesets
    // delete dataset
    try {
      await zb.zfs.destroy(datasetName, { recurse: true, force: true });
    } catch (err) {
      if (err.toString().includes("filesystem has dependent clones")) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          "filesystem has dependent clones"
        );
      }

      throw err;
    }

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ControllerExpandVolume(call) {
    const driver = this;
    const driverZfsResourceType = this.getDriverZfsResourceType();
    const zb = this.getZetabyte();

    let datasetParentName = this.getVolumeParentDatasetName();
    let name = call.request.volume_id;

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    if (!name) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    const datasetName = datasetParentName + "/" + name;

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

    if (capacity_bytes && driverZfsResourceType == "volume") {
      //make sure to align capacity_bytes with zvol blocksize
      //volume size must be a multiple of volume block size
      let properties = await zb.zfs.get(datasetName, ["volblocksize"]);
      properties = properties[datasetName];
      capacity_bytes = zb.helpers.generateZvolSize(
        capacity_bytes,
        properties.volblocksize.value
      );
    }

    if (
      call.request.capacity_range.required_bytes > 0 &&
      call.request.capacity_range.limit_bytes > 0 &&
      call.request.capacity_range.required_bytes >
        call.request.capacity_range.limit_bytes
    ) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `required_bytes is greather than limit_bytes`
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

    let setProps = false;
    let properties = {};

    switch (driverZfsResourceType) {
      case "filesystem":
        // set quota
        if (this.options.zfs.datasetEnableQuotas) {
          setProps = true;
          properties.refquota = capacity_bytes;
        }

        // set reserve
        if (this.options.zfs.datasetEnableReservation) {
          setProps = true;
          properties.refreservation = capacity_bytes;
        }
        break;
      case "volume":
        properties.volsize = capacity_bytes;
        setProps = true;

        if (this.options.zfs.zvolEnableReservation) {
          properties.refreservation = capacity_bytes;
        }
        break;
    }

    if (setProps) {
      await zb.zfs.set(datasetName, properties);
    }

    await this.expandVolume(call, datasetName);

    return {
      capacity_bytes: this.options.zfs.datasetEnableQuotas ? capacity_bytes : 0,
      node_expansion_required: driverZfsResourceType == "volume" ? true : false
    };
  }

  /**
   * TODO: consider volume_capabilities?
   *
   * @param {*} call
   */
  async GetCapacity(call) {
    const driver = this;
    const zb = this.getZetabyte();

    let datasetParentName = this.getVolumeParentDatasetName();

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    if (call.request.volume_capabilities) {
      const result = this.assertCapabilities(call.request.volume_capabilities);

      if (result.valid !== true) {
        return { available_capacity: 0 };
      }
    }

    const datasetName = datasetParentName;

    let properties;
    properties = await zb.zfs.get(datasetName, ["avail"]);
    properties = properties[datasetName];

    return { available_capacity: properties.available.value };
  }

  /**
   *
   * TODO: check capability to ensure not asking about block volumes
   *
   * @param {*} call
   */
  async ListVolumes(call) {
    const driver = this;
    const driverZfsResourceType = this.getDriverZfsResourceType();
    const zb = this.getZetabyte();

    let datasetParentName = this.getVolumeParentDatasetName();
    let entries = [];
    let entries_length = 0;
    let next_token;
    let uuid, page, next_page;
    let response;

    const max_entries = call.request.max_entries;
    const starting_token = call.request.starting_token;

    // get data from cache and return immediately
    if (starting_token) {
      let parts = starting_token.split(":");
      uuid = parts[0];
      page = parseInt(parts[1]);
      entries = this.ctx.cache.get(`ListVolumes:result:${uuid}`);
      if (entries) {
        entries = JSON.parse(JSON.stringify(entries));
        entries_length = entries.length;
        entries = entries.splice((page - 1) * max_entries, max_entries);
        if (page * max_entries < entries_length) {
          next_page = page + 1;
          next_token = `${uuid}:${next_page}`;
        } else {
          next_token = null;
        }
        const data = {
          entries: entries,
          next_token: next_token
        };

        return data;
      } else {
        // TODO: throw error / cache expired
      }
    }

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    const datasetName = datasetParentName;

    let types = [];
    switch (driverZfsResourceType) {
      case "filesystem":
        types = ["filesystem"];
        break;
      case "volume":
        types = ["volume"];
        break;
    }
    try {
      response = await zb.zfs.list(
        datasetName,
        [
          "name",
          "mountpoint",
          "refquota",
          "avail",
          "used",
          VOLUME_CSI_NAME_PROPERTY_NAME,
          VOLUME_CONTENT_SOURCE_TYPE_PROPERTY_NAME,
          VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME,
          "volsize",
          MANAGED_PROPERTY_NAME,
          SHARE_VOLUME_CONTEXT_PROPERTY_NAME,
          SUCCESS_PROPERTY_NAME
        ],
        { types, recurse: true }
      );
    } catch (err) {
      if (err.toString().includes("dataset does not exist")) {
        return {
          entries: [],
          next_token: null
        };
      }

      throw err;
    }

    driver.ctx.logger.debug("list volumes result: %j", response);

    // remove parent dataset from results
    if (driverZfsResourceType == "filesystem") {
      response.data.shift();
    }

    entries = [];
    response.indexed.forEach(row => {
      // ignore rows were csi_name is empty
      if (row[MANAGED_PROPERTY_NAME] != "true") {
        return;
      }

      let volume_content_source;
      if (
        zb.helpers.isPropertyValueSet(
          row[VOLUME_CONTENT_SOURCE_TYPE_PROPERTY_NAME]
        )
      ) {
        volume_content_source = {};
        switch (row[VOLUME_CONTENT_SOURCE_TYPE_PROPERTY_NAME]) {
          case "snapshot":
            volume_content_source.snapshot = {};
            volume_content_source.snapshot.snapshot_id =
              row[VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME];
            break;
          case "volume":
            volume_content_source.volume = {};
            volume_content_source.volume.volume_id =
              row[VOLUME_CONTENT_SOURCE_ID_PROPERTY_NAME];
            break;
        }
      }

      entries.push({
        volume: {
          // remove parent dataset info
          volume_id: row["name"].replace(
            new RegExp("^" + datasetName + "/"),
            ""
          ),
          capacity_bytes:
            driverZfsResourceType == "filesystem"
              ? row["refquota"]
              : row["volsize"],
          content_source: volume_content_source,
          volume_context: JSON.parse(row[SHARE_VOLUME_CONTEXT_PROPERTY_NAME])
        }
      });
    });

    if (max_entries && entries.length > max_entries) {
      uuid = uuidv4();
      this.ctx.cache.set(
        `ListVolumes:result:${uuid}`,
        JSON.parse(JSON.stringify(entries))
      );
      next_token = `${uuid}:2`;
      entries = entries.splice(0, max_entries);
    }

    const data = {
      entries: entries,
      next_token: next_token
    };

    return data;
  }

  /**
   *
   * @param {*} call
   */
  async ListSnapshots(call) {
    const driver = this;
    const driverZfsResourceType = this.getDriverZfsResourceType();
    const zb = this.getZetabyte();

    let entries = [];
    let entries_length = 0;
    let next_token;
    let uuid, page, next_page;

    const max_entries = call.request.max_entries;
    const starting_token = call.request.starting_token;

    let types = [];

    const volumeParentDatasetName = this.getVolumeParentDatasetName();
    const snapshotParentDatasetName = this.getDetachedSnapshotParentDatasetName();

    // get data from cache and return immediately
    if (starting_token) {
      let parts = starting_token.split(":");
      uuid = parts[0];
      page = parseInt(parts[1]);
      entries = this.ctx.cache.get(`ListSnapshots:result:${uuid}`);
      if (entries) {
        entries = JSON.parse(JSON.stringify(entries));
        entries_length = entries.length;
        entries = entries.splice((page - 1) * max_entries, max_entries);
        if (page * max_entries < entries_length) {
          next_page = page + 1;
          next_token = `${uuid}:${next_page}`;
        } else {
          next_token = null;
        }
        const data = {
          entries: entries,
          next_token: next_token
        };

        return data;
      } else {
        // TODO: throw error / cache expired
      }
    }

    if (!volumeParentDatasetName) {
      // throw error
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    let snapshot_id = call.request.snapshot_id;
    let source_volume_id = call.request.source_volume_id;

    entries = [];
    for (let loopType of ["snapshot", "filesystem"]) {
      let response, operativeFilesystem, operativeFilesystemType;
      let datasetParentName;
      switch (loopType) {
        case "snapshot":
          datasetParentName = volumeParentDatasetName;
          types = ["snapshot"];
          // should only send 1 of snapshot_id or source_volume_id, preferring the former if sent
          if (snapshot_id) {
            if (!zb.helpers.isZfsSnapshot(snapshot_id)) {
              return;
            }
            operativeFilesystem = volumeParentDatasetName + "/" + snapshot_id;
            operativeFilesystemType = 3;
          } else if (source_volume_id) {
            operativeFilesystem =
              volumeParentDatasetName + "/" + source_volume_id;
            operativeFilesystemType = 2;
          } else {
            operativeFilesystem = volumeParentDatasetName;
            operativeFilesystemType = 1;
          }
          break;
        case "filesystem":
          datasetParentName = snapshotParentDatasetName;
          if (!datasetParentName) {
            continue;
          }
          if (driverZfsResourceType == "filesystem") {
            types = ["filesystem"];
          } else {
            types = ["volume"];
          }

          // should only send 1 of snapshot_id or source_volume_id, preferring the former if sent
          if (snapshot_id) {
            if (zb.helpers.isZfsSnapshot(snapshot_id)) {
              continue;
            }
            operativeFilesystem = snapshotParentDatasetName + "/" + snapshot_id;
            operativeFilesystemType = 3;
          } else if (source_volume_id) {
            operativeFilesystem =
              snapshotParentDatasetName + "/" + source_volume_id;
            operativeFilesystemType = 2;
          } else {
            operativeFilesystem = snapshotParentDatasetName;
            operativeFilesystemType = 1;
          }
          break;
      }

      try {
        response = await zb.zfs.list(
          operativeFilesystem,
          [
            "name",
            "creation",
            "mountpoint",
            "refquota",
            "avail",
            "used",
            VOLUME_CSI_NAME_PROPERTY_NAME,
            SNAPSHOT_CSI_NAME_PROPERTY_NAME,
            MANAGED_PROPERTY_NAME
          ],
          { types, recurse: true }
        );
      } catch (err) {
        let message;
        if (err.toString().includes("dataset does not exist")) {
          switch (operativeFilesystemType) {
            case 1:
              //message = `invalid configuration: datasetParentName ${datasetParentName} does not exist`;
              continue;
              break;
            case 2:
              message = `source_volume_id ${source_volume_id} does not exist`;
              break;
            case 3:
              message = `snapshot_id ${snapshot_id} does not exist`;
              break;
          }
          throw new GrpcError(grpc.status.NOT_FOUND, message);
        }
        throw new GrpcError(grpc.status.FAILED_PRECONDITION, e.toString());
      }

      response.indexed.forEach(row => {
        // skip any snapshots not explicitly created by CO
        if (row[MANAGED_PROPERTY_NAME] != "true") {
          return;
        }

        // ignore snapshots that are not explicit CO snapshots
        if (
          !zb.helpers.isPropertyValueSet(row[SNAPSHOT_CSI_NAME_PROPERTY_NAME])
        ) {
          return;
        }

        // strip parent dataset
        let source_volume_id = row["name"].replace(
          new RegExp("^" + datasetParentName + "/"),
          ""
        );

        // strip snapshot details (@snapshot-name)
        if (source_volume_id.includes("@")) {
          source_volume_id = source_volume_id.substring(
            0,
            source_volume_id.indexOf("@")
          );
        } else {
          source_volume_id = source_volume_id.replace(
            new RegExp("/" + row[SNAPSHOT_CSI_NAME_PROPERTY_NAME] + "$"),
            ""
          );
        }

        if (source_volume_id == datasetParentName) {
          return;
        }

        if (source_volume_id)
          entries.push({
            snapshot: {
              /**
               * The purpose of this field is to give CO guidance on how much space
               * is needed to create a volume from this snapshot.
               *
               * In that vein, I think it's best to return 0 here given the
               * unknowns of 'cow' implications.
               */
              size_bytes: 0,

              // remove parent dataset details
              snapshot_id: row["name"].replace(
                new RegExp("^" + datasetParentName + "/"),
                ""
              ),
              source_volume_id: source_volume_id,
              //https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/timestamp.proto
              creation_time: {
                seconds: row["creation"],
                nanos: 0
              },
              ready_to_use: true
            }
          });
      });
    }

    if (max_entries && entries.length > max_entries) {
      uuid = uuidv4();
      this.ctx.cache.set(
        `ListSnapshots:result:${uuid}`,
        JSON.parse(JSON.stringify(entries))
      );
      next_token = `${uuid}:2`;
      entries = entries.splice(0, max_entries);
    }

    const data = {
      entries: entries,
      next_token: next_token
    };

    return data;
  }

  /**
   *
   * @param {*} call
   */
  async CreateSnapshot(call) {
    const driver = this;
    const driverZfsResourceType = this.getDriverZfsResourceType();
    const zb = this.getZetabyte();

    let detachedSnapshot = false;
    try {
      let tmpDetachedSnapshot = JSON.parse(
        driver.getNormalizedParameterValue(call.request.parameters, "detachedSnapshots")
      ); // snapshot class parameter
      if (typeof tmpDetachedSnapshot === "boolean") {
        detachedSnapshot = tmpDetachedSnapshot;
      }
    } catch (e) {}

    let response;
    const volumeParentDatasetName = this.getVolumeParentDatasetName();
    let datasetParentName;
    let snapshotProperties = {};
    let types = [];

    if (detachedSnapshot) {
      datasetParentName = this.getDetachedSnapshotParentDatasetName();
      if (driverZfsResourceType == "filesystem") {
        types.push("filesystem");
      } else {
        types.push("volume");
      }
    } else {
      datasetParentName = this.getVolumeParentDatasetName();
      types.push("snapshot");
    }

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

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

    const datasetName = datasetParentName + "/" + source_volume_id;
    snapshotProperties[SNAPSHOT_CSI_NAME_PROPERTY_NAME] = name;
    snapshotProperties[
      SNAPSHOT_CSI_SOURCE_VOLUME_ID_PROPERTY_NAME
    ] = source_volume_id;
    snapshotProperties[MANAGED_PROPERTY_NAME] = "true";

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

    let fullSnapshotName;
    let snapshotDatasetName;
    let tmpSnapshotName;
    if (detachedSnapshot) {
      fullSnapshotName = datasetName + "/" + name;
    } else {
      fullSnapshotName = datasetName + "@" + name;
    }

    driver.ctx.logger.verbose("full snapshot name: %s", fullSnapshotName);

    if (detachedSnapshot) {
      tmpSnapshotName =
        volumeParentDatasetName +
        "/" +
        source_volume_id +
        "@" +
        VOLUME_SOURCE_DETACHED_SNAPSHOT_PREFIX +
        name;
      snapshotDatasetName = datasetName + "/" + name;

      await zb.zfs.create(datasetName, { parents: true });

      try {
        await zb.zfs.snapshot(tmpSnapshotName);
      } catch (err) {
        if (err.toString().includes("dataset does not exist")) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            `snapshot source_volume_id ${source_volume_id} does not exist`
          );
        }

        throw err;
      }

      try {
        response = await zb.zfs.send_receive(
          tmpSnapshotName,
          [],
          snapshotDatasetName,
          []
        );

        response = await zb.zfs.set(snapshotDatasetName, snapshotProperties);
      } catch (err) {
        if (
          err.toString().includes("destination") &&
          err.toString().includes("exists")
        ) {
          // move along
        } else {
          throw err;
        }
      }

      // remove snapshot from target
      await zb.zfs.destroy(
        snapshotDatasetName +
          "@" +
          zb.helpers.extractSnapshotName(tmpSnapshotName),
        {
          recurse: true,
          force: true,
          defer: true
        }
      );

      // remove snapshot from source
      await zb.zfs.destroy(tmpSnapshotName, {
        recurse: true,
        force: true,
        defer: true
      });
    } else {
      try {
        await zb.zfs.snapshot(fullSnapshotName, {
          properties: snapshotProperties
        });
      } catch (err) {
        if (err.toString().includes("dataset does not exist")) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            `snapshot source_volume_id ${source_volume_id} does not exist`
          );
        }

        throw err;
      }
    }

    let properties;
    properties = await zb.zfs.get(
      fullSnapshotName,
      [
        "name",
        "creation",
        "mountpoint",
        "refquota",
        "avail",
        "used",
        VOLUME_CSI_NAME_PROPERTY_NAME,
        SNAPSHOT_CSI_NAME_PROPERTY_NAME,
        SNAPSHOT_CSI_SOURCE_VOLUME_ID_PROPERTY_NAME,
        MANAGED_PROPERTY_NAME
      ],
      { types }
    );
    properties = properties[fullSnapshotName];
    driver.ctx.logger.verbose("snapshot properties: %j", properties);

    // set this just before sending out response so we know if volume completed
    // this should give us a relatively sane way to clean up artifacts over time
    await zb.zfs.set(fullSnapshotName, { [SUCCESS_PROPERTY_NAME]: "true" });

    return {
      snapshot: {
        /**
         * The purpose of this field is to give CO guidance on how much space
         * is needed to create a volume from this snapshot.
         *
         * In that vein, I think it's best to return 0 here given the
         * unknowns of 'cow' implications.
         */
        size_bytes: 0,

        // remove parent dataset details
        snapshot_id: properties.name.value.replace(
          new RegExp("^" + datasetParentName + "/"),
          ""
        ),
        source_volume_id: source_volume_id,
        //https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/timestamp.proto
        creation_time: {
          seconds: properties.creation.value,
          nanos: 0
        },
        ready_to_use: true
      }
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
    const zb = this.getZetabyte();

    const snapshot_id = call.request.snapshot_id;

    if (!snapshot_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot_id is required`
      );
    }

    const detachedSnapshot = !zb.helpers.isZfsSnapshot(snapshot_id);
    let datasetParentName;

    if (detachedSnapshot) {
      datasetParentName = this.getDetachedSnapshotParentDatasetName();
    } else {
      datasetParentName = this.getVolumeParentDatasetName();
    }

    if (!datasetParentName) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing datasetParentName`
      );
    }

    const fullSnapshotName = datasetParentName + "/" + snapshot_id;

    driver.ctx.logger.verbose("deleting snapshot: %s", fullSnapshotName);

    try {
      await zb.zfs.destroy(fullSnapshotName, {
        recurse: true,
        force: true,
        defer: zb.helpers.isZfsSnapshot(snapshot_id) // only defer when snapshot
      });
    } catch (err) {
      if (err.toString().includes("snapshot has dependent clones")) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          "snapshot has dependent clones"
        );
      }

      throw err;
    }

    // cleanup parent dataset if possible
    if (detachedSnapshot) {
      let containerDataset = zb.helpers.extractParentDatasetName(
        fullSnapshotName
      );
      try {
        await this.removeSnapshotsFromDatatset(containerDataset);
        await zb.zfs.destroy(containerDataset);
      } catch (err) {
        if (!err.toString().includes("filesystem has children")) {
          throw err;
        }
      }
    }

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(call) {
    const driver = this;
    const result = this.assertCapabilities(call.request.volume_capabilities);

    if (result.valid !== true) {
      return { message: result.message };
    }

    return {
      confirmed: {
        volume_context: call.request.volume_context,
        volume_capabilities: call.request.volume_capabilities, // TODO: this is a bit crude, should return *ALL* capabilities, not just what was requested
        parameters: call.request.parameters
      }
    };
  }
}

module.exports.ControllerZfsSshBaseDriver = ControllerZfsSshBaseDriver;
