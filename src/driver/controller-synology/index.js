const _ = require("lodash");
const { CsiBaseDriver } = require("../index");
const GeneralUtils = require("../../utils/general");
const { GrpcError, grpc } = require("../../utils/grpc");
const Handlebars = require("handlebars");
const registry = require("../../utils/registry");
const SynologyHttpClient = require("./http").SynologyHttpClient;
const semver = require("semver");
const yaml = require("js-yaml");

const __REGISTRY_NS__ = "ControllerSynologyDriver";

/**
 *
 * Driver to provision storage on a synology device
 *
 */
class ControllerSynologyDriver extends CsiBaseDriver {
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

    const driverResourceType = this.getDriverResourceType();

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
        //"LIST_VOLUMES",
        "GET_CAPACITY",
        "CREATE_DELETE_SNAPSHOT",
        //"LIST_SNAPSHOTS",
        "CLONE_VOLUME",
        //"PUBLISH_READONLY",
        "EXPAND_VOLUME",
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        options.service.controller.capabilities.rpc
          .push
          //"VOLUME_CONDITION",
          //"GET_VOLUME" (would need to properly handle volume_content_source)
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
        //"EXPAND_VOLUME",
      ];

      if (driverResourceType == "volume") {
        options.service.node.capabilities.rpc.push("EXPAND_VOLUME");
      }

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

  async getHttpClient() {
    return registry.get(`${__REGISTRY_NS__}:http_client`, () => {
      return new SynologyHttpClient(this.options.httpConnection);
    });
  }

  getDriverResourceType() {
    switch (this.options.driver) {
      case "synology-nfs":
      case "synology-smb":
        return "filesystem";
      case "synology-iscsi":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  getDriverShareType() {
    switch (this.options.driver) {
      case "synology-nfs":
        return "nfs";
      case "synology-smb":
        return "smb";
      case "synology-iscsi":
        return "iscsi";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  getObjectFromDevAttribs(list = []) {
    if (!list) {
      return {};
    }
    return list.reduce(
      (obj, item) => Object.assign(obj, { [item.dev_attrib]: item.enable }),
      {}
    );
  }

  getDevAttribsFromObject(obj, keepNull = false) {
    return Object.entries(obj)
      .filter((e) => keepNull || e[1] != null)
      .map((e) => ({ dev_attrib: e[0], enable: e[1] }));
  }

  parseParameterYamlData(data, fieldHint = "") {
    try {
      return yaml.load(data);
    } catch {
      if (err instanceof yaml.YAMLException) {
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `${fieldHint} not a valid YAML document.`.trim()
        );
      } else {
        throw err;
      }
    }
  }

  buildIscsiName(volume_id) {
    let iscsiName = volume_id;
    if (this.options.iscsi.namePrefix) {
      iscsiName = this.options.iscsi.namePrefix + iscsiName;
    }

    if (this.options.iscsi.nameSuffix) {
      iscsiName += this.options.iscsi.nameSuffix;
    }

    return iscsiName.toLowerCase();
  }

  /**
   * Returns the value for the 'location' parameter indicating on which volume
   * a LUN is to be created.
   *
   * @param {Object} parameters - Parameters received from a StorageClass
   * @param {String} parameters.volume - The volume specified by the StorageClass
   * @returns {String} The location of the volume.
   */
  getLocation() {
    let location = _.get(this.options, "synology.volume");
    if (!location) {
      location = "volume1";
    }
    if (!location.startsWith("/")) {
      location = "/" + location;
    }
    return location;
  }

  getAccessModes(capability) {
    let access_modes = _.get(this.options, "csi.access_modes", null);
    if (access_modes !== null) {
      return access_modes;
    }

    const driverResourceType = this.getDriverResourceType();
    switch (driverResourceType) {
      case "filesystem":
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
        break;
      case "volume":
        access_modes = [
          "UNKNOWN",
          "SINGLE_NODE_WRITER",
          "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
          "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
          "SINGLE_NODE_READER_ONLY",
          "MULTI_NODE_READER_ONLY",
          "MULTI_NODE_SINGLE_WRITER",
        ];
        break;
    }

    if (
      capability.access_type == "block" &&
      !access_modes.includes("MULTI_NODE_MULTI_WRITER")
    ) {
      access_modes.push("MULTI_NODE_MULTI_WRITER");
    }

    return access_modes;
  }

  assertCapabilities(capabilities) {
    const driverResourceType = this.getDriverResourceType();
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
    const valid = capabilities.every((capability) => {
      switch (driverResourceType) {
        case "filesystem":
          if (capability.access_type != "mount") {
            message = `invalid access_type ${capability.access_type}`;
            return false;
          }

          if (
            capability.mount.fs_type &&
            !GeneralUtils.default_supported_file_filesystems().includes(
              capability.mount.fs_type
            )
          ) {
            message = `invalid fs_type ${capability.mount.fs_type}`;
            return false;
          }

          if (
            !this.getAccessModes(capability).includes(
              capability.access_mode.mode
            )
          ) {
            message = `invalid access_mode, ${capability.access_mode.mode}`;
            return false;
          }

          return true;
        case "volume":
          if (capability.access_type == "mount") {
            if (
              capability.mount.fs_type &&
              !GeneralUtils.default_supported_block_filesystems().includes(
                capability.mount.fs_type
              )
            ) {
              message = `invalid fs_type ${capability.mount.fs_type}`;
              return false;
            }
          }

          if (
            !this.getAccessModes(capability).includes(
              capability.access_mode.mode
            )
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
   *
   * CreateVolume
   *
   * @param {*} call
   */
  async CreateVolume(call) {
    const driver = this;
    const httpClient = await driver.getHttpClient();

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
        required_bytes: 1073741824,
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

    let volume_context = {};
    const normalizedParameters = driver.getNormalizedParameters(
      call.request.parameters
    );
    switch (driver.getDriverShareType()) {
      case "nfs":
        // TODO: create volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "smb":
        // TODO: create volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "iscsi":
        let iscsiName = driver.buildIscsiName(volume_id);
        let lunTemplate;
        let targetTemplate;
        let data;
        let target;
        let lun_mapping;
        let lun_uuid;
        let existingLun;

        lunTemplate = Object.assign(
          {},
          _.get(driver.options, "iscsi.lunTemplate", {}),
          driver.parseParameterYamlData(
            _.get(normalizedParameters, "lunTemplate", "{}"),
            "parameters.lunTemplate"
          ),
          driver.parseParameterYamlData(
            _.get(call.request, "secrets.lunTemplate", "{}"),
            "secrets.lunTemplate"
          )
        );
        targetTemplate = Object.assign(
          {},
          _.get(driver.options, "iscsi.targetTemplate", {}),
          driver.parseParameterYamlData(
            _.get(normalizedParameters, "targetTemplate", "{}"),
            "parameters.targetTemplate"
          ),
          driver.parseParameterYamlData(
            _.get(call.request, "secrets.targetTemplate", "{}"),
            "secrets.targetTemplate"
          )
        );

        // render the template for description
        if (lunTemplate.description) {
          lunTemplate.description = Handlebars.compile(lunTemplate.description)(
            {
              name: call.request.name,
              parameters: call.request.parameters,
              csi: {
                name: this.ctx.args.csiName,
                version: this.ctx.args.csiVersion,
              },
            }
          );
        }

        // ensure volumes with the same name being requested a 2nd time but with a different size fails
        try {
          let lun = await httpClient.GetLunByName(iscsiName);
          if (lun) {
            let size = lun.size;
            let check = true;
            if (check) {
              if (
                (call.request.capacity_range.required_bytes &&
                  call.request.capacity_range.required_bytes > 0 &&
                  size < call.request.capacity_range.required_bytes) ||
                (call.request.capacity_range.limit_bytes &&
                  call.request.capacity_range.limit_bytes > 0 &&
                  size > call.request.capacity_range.limit_bytes)
              ) {
                throw new GrpcError(
                  grpc.status.ALREADY_EXISTS,
                  `volume has already been created with a different size, existing size: ${size}, required_bytes: ${call.request.capacity_range.required_bytes}, limit_bytes: ${call.request.capacity_range.limit_bytes}`
                );
              }
            }
          }
        } catch (err) {
          throw err;
        }

        if (volume_content_source) {
          let src_lun_uuid;
          switch (volume_content_source.type) {
            case "snapshot":
              let parts = volume_content_source.snapshot.snapshot_id.split("/");

              src_lun_uuid = parts[2];
              if (!src_lun_uuid) {
                throw new GrpcError(
                  grpc.status.NOT_FOUND,
                  `invalid snapshot_id: ${volume_content_source.snapshot.snapshot_id}`
                );
              }

              let snapshot_uuid = parts[3];
              if (!snapshot_uuid) {
                throw new GrpcError(
                  grpc.status.NOT_FOUND,
                  `invalid snapshot_id: ${volume_content_source.snapshot.snapshot_id}`
                );
              }

              // This is for backwards compatibility. Previous versions of this driver used the LUN ID instead of the
              // UUID. If this is the case we need to get the LUN UUID before we can proceed.
              if (!src_lun_uuid.includes("-")) {
                src_lun_uuid = await httpClient.GetLunByID(src_lun_uuid).uuid;
              }

              let snapshot =
                await httpClient.GetSnapshotByLunUUIDAndSnapshotUUID(
                  src_lun_uuid,
                  snapshot_uuid
                );
              if (!snapshot) {
                throw new GrpcError(
                  grpc.status.NOT_FOUND,
                  `invalid snapshot_id: ${volume_content_source.snapshot.snapshot_id}`
                );
              }

              existingLun = await httpClient.GetLunByName(iscsiName);
              if (!existingLun) {
                await httpClient.CreateVolumeFromSnapshot(
                  src_lun_uuid,
                  snapshot_uuid,
                  iscsiName,
                  lunTemplate.description
                );
              }
              break;
            case "volume":
              existingLun = await httpClient.GetLunByName(iscsiName);
              if (!existingLun) {
                let srcLunName = driver.buildIscsiName(
                  volume_content_source.volume.volume_id
                );
                if (!srcLunName) {
                  throw new GrpcError(
                    grpc.status.NOT_FOUND,
                    `invalid volume_id: ${volume_content_source.volume.volume_id}`
                  );
                }

                src_lun_uuid = await httpClient.GetLunUUIDByName(srcLunName);
                if (!src_lun_uuid) {
                  throw new GrpcError(
                    grpc.status.NOT_FOUND,
                    `invalid volume_id: ${volume_content_source.volume.volume_id}`
                  );
                }
                await httpClient.CreateClonedVolume(
                  src_lun_uuid,
                  iscsiName,
                  driver.getLocation(),
                  lunTemplate.description
                );
              }
              break;
            default:
              throw new GrpcError(
                grpc.status.INVALID_ARGUMENT,
                `invalid volume_content_source type: ${volume_content_source.type}`
              );
              break;
          }
          // resize to requested amount

          let lun = await httpClient.GetLunByName(iscsiName);
          lun_uuid = lun.uuid;
          if (lun.size < capacity_bytes) {
            await httpClient.ExpandISCSILun(lun_uuid, capacity_bytes);
          }
        } else {
          // create lun
          data = Object.assign({}, lunTemplate, {
            name: iscsiName,
            location: driver.getLocation(),
            size: capacity_bytes,
          });

          lun_uuid = await httpClient.CreateLun(data);
        }

        // create target
        let iqn = driver.options.iscsi.baseiqn + iscsiName;
        data = Object.assign({}, targetTemplate, {
          name: iscsiName,
          iqn,
        });

        let target_id = await httpClient.CreateTarget(data);
        //target = await httpClient.GetTargetByTargetID(target_id);
        target = await httpClient.GetTargetByIQN(iqn);
        if (!target) {
          throw new GrpcError(
            grpc.status.UNKNOWN,
            `failed to lookup target: ${iqn}`
          );
        }

        target_id = target.target_id;

        // check if mapping of lun <-> target already exists
        lun_mapping = target.mapped_luns.find((lun) => {
          return lun.lun_uuid == lun_uuid;
        });

        // create mapping if not present already
        if (!lun_mapping) {
          data = {
            uuid: lun_uuid,
            target_ids: [target_id],
          };
          /*
          data = {
            lun_uuids: [lun_uuid],
            target_id: target_id,
          };
          */
          await httpClient.MapLun(data);

          // re-retrieve target to ensure proper lun (mapping_index) value is returned
          target = await httpClient.GetTargetByTargetID(target_id);
          lun_mapping = target.mapped_luns.find((lun) => {
            return lun.lun_uuid == lun_uuid;
          });
        }

        if (!lun_mapping) {
          throw new GrpcError(
            grpc.status.UNKNOWN,
            `failed to lookup lun_mapping_id`
          );
        }

        volume_context = {
          node_attach_driver: "iscsi",
          portal: driver.options.iscsi.targetPortal || "",
          portals: driver.options.iscsi.targetPortals
            ? driver.options.iscsi.targetPortals.join(",")
            : "",
          interface: driver.options.iscsi.interface || "",
          iqn,
          lun: lun_mapping.mapping_index,
        };
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
    }

    volume_context["provisioner_driver"] = driver.options.driver;
    if (driver.options.instance_id) {
      volume_context["provisioner_driver_instance_id"] =
        driver.options.instance_id;
    }

    const res = {
      volume: {
        volume_id,
        capacity_bytes, // kubernetes currently pukes if capacity is returned as 0
        content_source: volume_content_source,
        volume_context,
      },
    };

    return res;
  }

  /**
   * DeleteVolume
   *
   * @param {*} call
   */
  async DeleteVolume(call) {
    const driver = this;
    const httpClient = await driver.getHttpClient();

    let volume_id = call.request.volume_id;

    if (!volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
      );
    }

    let response;

    switch (driver.getDriverShareType()) {
      case "nfs":
        // TODO: delete volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "smb":
        // TODO: delete volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "iscsi":
        //await httpClient.DeleteAllLuns();

        let iscsiName = driver.buildIscsiName(volume_id);
        let iqn = driver.options.iscsi.baseiqn + iscsiName;

        let target = await httpClient.GetTargetByIQN(iqn);
        if (target) {
          await httpClient.DeleteTarget(target.target_id);
        }

        let lun_uuid = await httpClient.GetLunUUIDByName(iscsiName);
        if (lun_uuid) {
          // this is an async process where a success is returned but delete is happening still behind the scenes
          // therefore we continue to search for the lun after delete success call to ensure full deletion
          await httpClient.DeleteLun(lun_uuid);

          //let settleEnabled = driver.options.api.lunDelete.settleEnabled;
          let settleEnabled = true;

          if (settleEnabled) {
            let currentCheck = 0;

            /*
            let settleMaxRetries =
              driver.options.api.lunDelete.settleMaxRetries || 6;
            let settleSeconds = driver.options.api.lunDelete.settleSeconds || 5;
            */

            let settleMaxRetries = 6;
            let settleSeconds = 5;

            let waitTimeBetweenChecks = settleSeconds * 1000;

            await GeneralUtils.sleep(waitTimeBetweenChecks);
            lun_uuid = await httpClient.GetLunUUIDByName(iscsiName);

            while (currentCheck <= settleMaxRetries && lun_uuid) {
              currentCheck++;
              await GeneralUtils.sleep(waitTimeBetweenChecks);
              lun_uuid = await httpClient.GetLunUUIDByName(iscsiName);
            }

            if (lun_uuid) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `failed to remove lun: ${lun_uuid}`
              );
            }
          }
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
    }

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ControllerExpandVolume(call) {
    const driver = this;
    const httpClient = await driver.getHttpClient();

    let volume_id = call.request.volume_id;

    if (!volume_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `volume_id is required`
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

    let node_expansion_required = false;
    let response;

    switch (driver.getDriverShareType()) {
      case "nfs":
        // TODO: expand volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "smb":
        // TODO: expand volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "iscsi":
        node_expansion_required = true;
        let iscsiName = driver.buildIscsiName(volume_id);

        response = await httpClient.GetLunUUIDByName(iscsiName);
        await httpClient.ExpandISCSILun(response, capacity_bytes);
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
    }

    return {
      capacity_bytes,
      node_expansion_required,
    };
  }

  /**
   * TODO: consider volume_capabilities?
   *
   * @param {*} call
   */
  async GetCapacity(call) {
    const driver = this;
    const httpClient = await driver.getHttpClient();
    const location = driver.getLocation();

    if (!location) {
      throw new GrpcError(
        grpc.status.FAILED_PRECONDITION,
        `invalid configuration: missing volume`
      );
    }

    if (call.request.volume_capabilities) {
      const result = this.assertCapabilities(call.request.volume_capabilities);

      if (result.valid !== true) {
        return { available_capacity: 0 };
      }
    }

    let response = await httpClient.GetVolumeInfo(location);
    return { available_capacity: response.body.data.volume.size_free_byte };
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
    const httpClient = await driver.getHttpClient();

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

    let iscsiName = driver.buildIscsiName(source_volume_id);
    let lun = await httpClient.GetLunByName(iscsiName);

    if (!lun) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `invalid source_volume_id: ${source_volume_id}`
      );
    }

    const normalizedParameters = driver.getNormalizedParameters(
      call.request.parameters
    );
    let lunSnapshotTemplate;

    lunSnapshotTemplate = Object.assign(
      {},
      _.get(driver.options, "iscsi.lunSnapshotTemplate", {}),
      driver.parseParameterYamlData(
        _.get(normalizedParameters, "lunSnapshotTemplate", "{}"),
        "parameters.lunSnapshotTemplate"
      ),
      driver.parseParameterYamlData(
        _.get(call.request, "secrets.lunSnapshotTemplate", "{}"),
        "secrets.lunSnapshotTemplate"
      )
    );

    // check for other snapshopts with the same name on other volumes and fail as appropriate
    // TODO: technically this should only be checking lun/snapshots relevant to this specific install of the driver
    // but alas an isolation/namespacing mechanism does not exist in synology
    let snapshots = await httpClient.GetSnapshots();
    for (let snapshot of snapshots) {
      if (snapshot.description == name && snapshot.parent_uuid != lun.uuid) {
        throw new GrpcError(
          grpc.status.ALREADY_EXISTS,
          `snapshot name: ${name} is incompatible with source_volume_id: ${source_volume_id} due to being used with another source_volume_id`
        );
      }
    }

    // check for already exists
    let snapshot;
    snapshot = await httpClient.GetSnapshotByLunUUIDAndName(lun.uuid, name);
    if (!snapshot) {
      let data = Object.assign({}, lunSnapshotTemplate, {
        src_lun_uuid: lun.uuid,
        taken_by: "democratic-csi",
        description: name, //check
      });

      await httpClient.CreateSnapshot(data);
      snapshot = await httpClient.GetSnapshotByLunUUIDAndName(lun.uuid, name);

      if (!snapshot) {
        throw new Error(`failed to create snapshot`);
      }
    }

    return {
      snapshot: {
        /**
         * The purpose of this field is to give CO guidance on how much space
         * is needed to create a volume from this snapshot.
         */
        size_bytes: snapshot.total_size,
        snapshot_id: `/lun/${lun.uuid}/${snapshot.uuid}`,
        source_volume_id: source_volume_id,
        //https://github.com/protocolbuffers/protobuf/blob/master/src/google/protobuf/timestamp.proto
        creation_time: {
          seconds: snapshot.time,
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
    // throw new GrpcError(
    //   grpc.status.UNIMPLEMENTED,
    //   `operation not supported by driver`
    // );

    const driver = this;
    const httpClient = await driver.getHttpClient();

    const snapshot_id = call.request.snapshot_id;

    if (!snapshot_id) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `snapshot_id is required`
      );
    }

    let parts = snapshot_id.split("/");
    let lun_uuid = parts[2];
    if (!lun_uuid) {
      return {};
    }

    let snapshot_uuid = parts[3];
    if (!snapshot_uuid) {
      return {};
    }

    // This is for backwards compatibility. Previous versions of this driver used the LUN ID instead of the UUID. If
    // this is the case we need to get the LUN UUID before we can proceed.
    if (!lun_uuid.includes("-")) {
      lun_uuid = await httpClient.GetLunByID(lun_uuid).uuid;
    }

    let snapshot = await httpClient.GetSnapshotByLunUUIDAndSnapshotUUID(
      lun_uuid,
      snapshot_uuid
    );

    if (snapshot) {
      await httpClient.DeleteSnapshot(snapshot.uuid);
    }

    return {};
  }

  /**
   *
   * @param {*} call
   */
  async ValidateVolumeCapabilities(call) {
    const driver = this;
    const httpClient = await driver.getHttpClient();

    let response;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }

    const capabilities = call.request.volume_capabilities;
    if (!capabilities || capabilities.length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capabilities`);
    }

    switch (driver.getDriverShareType()) {
      case "nfs":
        // TODO: expand volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "smb":
        // TODO: expand volume here
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
      case "iscsi":
        let iscsiName = driver.buildIscsiName(volume_id);

        response = await httpClient.GetLunUUIDByName(iscsiName);
        if (!response) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `invalid volume_id: ${volume_id}`
          );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `operation not supported by driver`
        );
        break;
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

module.exports.ControllerSynologyDriver = ControllerSynologyDriver;
