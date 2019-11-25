const grpc = require("grpc");
const { ControllerZfsSshBaseDriver } = require("../controller-zfs-ssh");
const { GrpcError } = require("../../utils/grpc");
const HttpClient = require("./http").Client;

// freenas properties
const FREENAS_NFS_SHARE_PROPERTY_NAME = "democratic-csi:freenas_nfs_share_id";
const FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_target_id";
const FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_extent_id";
const FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_targettoextent_id";

class FreeNASDriver extends ControllerZfsSshBaseDriver {
  /**
   * cannot make this a storage class parameter as storage class/etc context is *not* sent
   * into various calls such as GetControllerCapabilities etc
   */
  getDriverZfsResourceType() {
    switch (this.options.driver) {
      case "freenas-nfs":
        return "filesystem";
      case "freenas-iscsi":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  getHttpClient() {
    const client = new HttpClient(this.options.httpConnection);
    client.logger = this.ctx.logger;
    return client;
  }

  getDriverShareType() {
    switch (this.options.driver) {
      case "freenas-nfs":
        return "nfs";
      case "freenas-iscsi":
        return "iscsi";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  async findResourceByProperties(endpoint, match) {
    if (!match || Object.keys(match).length < 1) {
      return;
    }
    const httpClient = this.getHttpClient();
    let target;
    let page = 0;

    // loop and find target
    let queryParams = {};
    // TODO: relax this using getSystemVersion perhaps
    // https://jira.ixsystems.com/browse/NAS-103916
    if (httpClient.getApiVersion() == 1) {
      queryParams.limit = 100;
      queryParams.offset = 0;
    }

    while (!target) {
      //Content-Range: items 0-2/3 (full set)
      //Content-Range: items 0--1/3 (invalid offset)
      if (queryParams.hasOwnProperty("offset")) {
        queryParams.offset = queryParams.limit * page;
      }

      let response = await httpClient.get(endpoint, queryParams);

      if (response.statusCode == 200) {
        if (response.body.length < 1) {
          break;
        }
        response.body.some(i => {
          let isMatch = true;
          for (let property in match) {
            if (match[property] != i[property]) {
              isMatch = false;
              break;
            }
          }

          if (isMatch) {
            target = i;
            return true;
          }

          return false;
        });
      } else {
        throw new Error(
          "FreeNAS http error - code: " +
            response.statusCode +
            " body: " +
            JSON.stringify(response.body)
        );
      }
      page++;
    }

    return target;
  }

  /**
   * should create any necessary share resources
   * should set the SHARE_VOLUME_CONTEXT_PROPERTY_NAME propery
   *
   * @param {*} datasetName
   */
  async createShare(call, datasetName) {
    const driverShareType = this.getDriverShareType();
    const httpClient = this.getHttpClient();
    const apiVersion = httpClient.getApiVersion();
    const zb = this.getZetabyte();

    let properties;
    let response;
    let share = {};

    switch (driverShareType) {
      case "nfs":
        properties = await zb.zfs.get(datasetName, [
          "mountpoint",
          FREENAS_NFS_SHARE_PROPERTY_NAME
        ]);
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        // create nfs share
        if (
          !zb.helpers.isPropertyValueSet(
            properties[FREENAS_NFS_SHARE_PROPERTY_NAME].value
          )
        ) {
          switch (apiVersion) {
            case 1:
            case 2:
              switch (apiVersion) {
                case 1:
                  share = {
                    nfs_paths: [properties.mountpoint.value],
                    nfs_comment: `democratic-csi (${this.ctx.args.csiName}): ${datasetName}`,
                    nfs_network: this.options.nfs.shareAllowedNetworks.join(
                      ","
                    ),
                    nfs_hosts: this.options.nfs.shareAllowedHosts.join(","),
                    nfs_alldirs: this.options.nfs.shareAlldirs,
                    nfs_ro: false,
                    nfs_quiet: false,
                    nfs_maproot_user: this.options.nfs.shareMaprootUser,
                    nfs_maproot_group: this.options.nfs.shareMaprootGroup,
                    nfs_mapall_user: this.options.nfs.shareMapallUser,
                    nfs_mapall_group: this.options.nfs.shareMapallGroup,
                    nfs_security: []
                  };
                  break;
                case 2:
                  share = {
                    paths: [properties.mountpoint.value],
                    comment: `democratic-csi (${this.ctx.args.csiName}): ${datasetName}`,
                    networks: this.options.nfs.shareAllowedNetworks,
                    hosts: this.options.nfs.shareAllowedHosts,
                    alldirs: this.options.nfs.shareAlldirs,
                    ro: false,
                    quiet: false,
                    maproot_user: this.options.nfs.shareMaprootUser,
                    maproot_group: this.options.nfs.shareMaprootGroup,
                    mapall_user: this.options.nfs.shareMapallUser,
                    mapall_group: this.options.nfs.shareMapallGroup,
                    security: []
                  };
                  break;
              }

              response = await httpClient.post("/sharing/nfs", share);

              /**
               * v1 = 201
               * v2 = 200
               */
              if ([200, 201].includes(response.statusCode)) {
                //set zfs property
                await zb.zfs.set(datasetName, {
                  [FREENAS_NFS_SHARE_PROPERTY_NAME]: response.body.id
                });
              } else {
                /**
                 * v1 = 409
                 * v2 = 422
                 */
                if (
                  [409, 422].includes(response.statusCode) &&
                  JSON.stringify(response.body).includes(
                    "You can't share same filesystem with all hosts twice."
                  )
                ) {
                  // move along
                } else {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `received error creating nfs share - code: ${response.statusCode} body: ${response.body}`
                  );
                }
              }

              let volume_context = {
                node_attach_driver: "nfs",
                server: this.options.nfs.shareHost,
                share: properties.mountpoint.value
              };
              return volume_context;

            default:
              throw new GrpcError(
                grpc.status.FAILED_PRECONDITION,
                `invalid configuration: unknown apiVersion ${apiVersion}`
              );
          }
        } else {
          let volume_context = {
            node_attach_driver: "nfs",
            server: this.options.nfs.shareHost,
            share: properties.mountpoint.value
          };
          return volume_context;
        }
        break;
      case "iscsi":
        properties = await zb.zfs.get(datasetName, [
          FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME,
          FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME,
          FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME
        ]);
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        let basename;
        let iscsiName = zb.helpers.extractLeafName(datasetName);
        if (this.options.iscsi.namePrefix) {
          iscsiName = this.options.iscsi.namePrefix + iscsiName;
        }

        if (this.options.iscsi.nameSuffix) {
          iscsiName += this.options.iscsi.nameSuffix;
        }

        iscsiName = iscsiName.toLowerCase();

        let extentDiskName = "zvol/" + datasetName;

        /**
         * limit is a FreeBSD limitation
         * https://www.ixsystems.com/documentation/freenas/11.2-U5/storage.html#zfs-zvol-config-opts-tab
         */
        if (extentDiskName.length > 63) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            `extent disk name cannot exceed 63 characters:  ${extentDiskName}`
          );
        }

        this.ctx.logger.info(
          "FreeNAS creating iscsi assets with name: " + iscsiName
        );

        const extentInsecureTpc = this.options.iscsi.hasOwnProperty(
          "extentInsecureTpc"
        )
          ? this.options.iscsi.extentInsecureTpc
          : true;

        const extentXenCompat = this.options.iscsi.hasOwnProperty(
          "extentXenCompat"
        )
          ? this.options.iscsi.extentXenCompat
          : false;

        const extentBlocksize = this.options.iscsi.hasOwnProperty(
          "extentBlocksize"
        )
          ? this.options.iscsi.extentBlocksize
          : 512;

        const extentDisablePhysicalBlocksize = this.options.iscsi.hasOwnProperty(
          "extentDisablePhysicalBlocksize"
        )
          ? this.options.iscsi.extentDisablePhysicalBlocksize
          : true;

        const extentRpm = this.options.iscsi.hasOwnProperty("extentRpm")
          ? this.options.iscsi.extentRpm
          : "SSD";

        const extentAvailThreshold = this.options.iscsi.hasOwnProperty(
          "extentAvailThreshold"
        )
          ? this.options.iscsi.extentAvailThreshold
          : null;

        switch (apiVersion) {
          case 1: {
            response = await httpClient.get(
              "/services/iscsi/globalconfiguration"
            );
            if (response.statusCode != 200) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `error getting iscsi configuration - code: ${
                  response.statusCode
                } body: ${JSON.stringify(response.body)}`
              );
            }
            basename = response.body.iscsi_basename;
            this.ctx.logger.verbose("FreeNAS ISCSI BASENAME: " + basename);

            // create target
            let target = {
              iscsi_target_name: iscsiName,
              iscsi_target_alias: ""
            };

            response = await httpClient.post("/services/iscsi/target", target);

            // 409 if invalid
            if (response.statusCode != 201) {
              target = null;
              if (
                response.statusCode == 409 &&
                JSON.stringify(response.body).includes(
                  "Target name already exists"
                )
              ) {
                target = await this.findResourceByProperties(
                  "/services/iscsi/target",
                  {
                    iscsi_target_name: iscsiName
                  }
                );
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi target - code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            } else {
              target = response.body;
            }

            if (!target) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi target`
              );
            }

            this.ctx.logger.verbose("FreeNAS ISCSI TARGET: %j", target);

            // set target.id on zvol
            await zb.zfs.set(datasetName, {
              [FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME]: target.id
            });

            // create targetgroup(s)
            // targetgroups do have IDs
            for (let targetGroupConfig of this.options.iscsi.targetGroups) {
              let targetGroup = {
                iscsi_target: target.id,
                iscsi_target_authgroup: targetGroupConfig.targetGroupAuthGroup,
                iscsi_target_authtype: targetGroupConfig.targetGroupAuthType
                  ? targetGroupConfig.targetGroupAuthType
                  : "None",
                iscsi_target_portalgroup:
                  targetGroupConfig.targetGroupPortalGroup,
                iscsi_target_initiatorgroup:
                  targetGroupConfig.targetGroupInitiatorGroup,
                iscsi_target_initialdigest: "Auto"
              };
              response = await httpClient.post(
                "/services/iscsi/targetgroup",
                targetGroup
              );

              // 409 if invalid
              if (response.statusCode != 201) {
                targetGroup = null;
                /**
                 * 404 gets returned with an unable to process response when the DB is corrupted (has invalid entries in essense)
                 *
                 * To resolve properly the DB should be cleaned up
                 * /usr/local/etc/rc.d/django stop
                 * /usr/local/etc/rc.d/nginx stop
                 * sqlite3 /data/freenas-v1.db
                 *
                 * // this deletes everything, probably not what you want
                 * // should have a better query to only find entries where associated assets no longer exist
                 * DELETE from services_iscsitargetgroups;
                 *
                 * /usr/local/etc/rc.d/django restart
                 * /usr/local/etc/rc.d/nginx restart
                 */
                if (
                  response.statusCode == 404 ||
                  (response.statusCode == 409 &&
                    JSON.stringify(response.body).includes(
                      "cannot be duplicated on a target"
                    ))
                ) {
                  targetGroup = await this.findResourceByProperties(
                    "/services/iscsi/targetgroup",
                    {
                      iscsi_target: target.id,
                      iscsi_target_portalgroup:
                        targetGroupConfig.targetGroupPortalGroup,
                      iscsi_target_initiatorgroup:
                        targetGroupConfig.targetGroupInitiatorGroup
                    }
                  );
                } else {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `received error creating iscsi targetgroup - code: ${
                      response.statusCode
                    } body: ${JSON.stringify(response.body)}`
                  );
                }
              } else {
                targetGroup = response.body;
              }

              if (!targetGroup) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `unknown error creating iscsi targetgroup`
                );
              }

              this.ctx.logger.verbose(
                "FreeNAS ISCSI TARGET_GROUP: %j",
                targetGroup
              );
            }

            let extent = {
              iscsi_target_extent_comment: "",
              iscsi_target_extent_type: "Disk", // Disk/File, after save Disk becomes "ZVOL"
              iscsi_target_extent_name: iscsiName,
              iscsi_target_extent_insecure_tpc: extentInsecureTpc,
              //iscsi_target_extent_naa: "0x3822690834aae6c5",
              iscsi_target_extent_disk: extentDiskName,
              iscsi_target_extent_xen: extentXenCompat,
              iscsi_target_extent_avail_threshold: extentAvailThreshold,
              iscsi_target_extent_blocksize: Number(extentBlocksize),
              iscsi_target_extent_pblocksize: extentDisablePhysicalBlocksize,
              iscsi_target_extent_rpm: isNaN(Number(extentRpm))
                ? "SSD"
                : Number(extentRpm),
              iscsi_target_extent_ro: false
            };
            response = await httpClient.post("/services/iscsi/extent", extent);

            // 409 if invalid
            if (response.statusCode != 201) {
              extent = null;
              if (
                response.statusCode == 409 &&
                JSON.stringify(response.body).includes(
                  "Extent name must be unique"
                )
              ) {
                extent = await this.findResourceByProperties(
                  "/services/iscsi/extent",
                  { iscsi_target_extent_name: iscsiName }
                );
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi extent - code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            } else {
              extent = response.body;
            }

            if (!extent) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi extent`
              );
            }
            this.ctx.logger.verbose("FreeNAS ISCSI EXTENT: %j", extent);

            await zb.zfs.set(datasetName, {
              [FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME]: extent.id
            });

            // create targettoextent
            let targetToExtent = {
              iscsi_target: target.id,
              iscsi_extent: extent.id,
              iscsi_lunid: 0
            };
            response = await httpClient.post(
              "/services/iscsi/targettoextent",
              targetToExtent
            );

            // 409 if invalid
            if (response.statusCode != 201) {
              targetToExtent = null;

              // LUN ID is already being used for this target.
              // Extent is already in this target.
              if (
                response.statusCode == 409 &&
                JSON.stringify(response.body).includes(
                  "Extent is already in this target."
                ) &&
                JSON.stringify(response.body).includes(
                  "LUN ID is already being used for this target."
                )
              ) {
                targetToExtent = await this.findResourceByProperties(
                  "/services/iscsi/targettoextent",
                  {
                    iscsi_target: target.id,
                    iscsi_extent: extent.id,
                    iscsi_lunid: 0
                  }
                );
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi targettoextent - code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            } else {
              targetToExtent = response.body;
            }

            if (!targetToExtent) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi targettoextent`
              );
            }
            this.ctx.logger.verbose(
              "FreeNAS ISCSI TARGET_TO_EXTENT: %j",
              targetToExtent
            );

            await zb.zfs.set(datasetName, {
              [FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME]: targetToExtent.id
            });

            break;
          }
          case 2:
            response = await httpClient.get("/iscsi/global");
            if (response.statusCode != 200) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `error getting iscsi configuration - code: ${
                  response.statusCode
                } body: ${JSON.stringify(response.body)}`
              );
            }
            basename = response.body.basename;
            this.ctx.logger.verbose("FreeNAS ISCSI BASENAME: " + basename);

            // create target and targetgroup
            //let targetId;
            let targetGroups = [];
            for (let targetGroupConfig of this.options.iscsi.targetGroups) {
              targetGroups.push({
                portal: targetGroupConfig.targetGroupPortalGroup,
                initiator: targetGroupConfig.targetGroupInitiatorGroup,
                auth:
                  targetGroupConfig.targetGroupAuthGroup > 0
                    ? targetGroupConfig.targetGroupAuthGroup
                    : null,
                authmethod:
                  targetGroupConfig.targetGroupAuthType.length > 0
                    ? targetGroupConfig.targetGroupAuthType
                        .toUpperCase()
                        .replace(" ", "_")
                    : "NONE"
              });
            }
            let target = {
              name: iscsiName,
              alias: null, // cannot send "" error: handler error - driver: FreeNASDriver method: CreateVolume error: {"name":"GrpcError","code":2,"message":"received error creating iscsi target - code: 422 body: {\"iscsi_target_create.alias\":[{\"message\":\"Alias already exists\",\"errno\":22}]}"}
              mode: "ISCSI",
              groups: targetGroups
            };

            response = await httpClient.post("/iscsi/target", target);

            // 409 if invalid
            if (response.statusCode != 200) {
              target = null;
              if (
                response.statusCode == 422 &&
                JSON.stringify(response.body).includes(
                  "Target name already exists"
                )
              ) {
                target = await this.findResourceByProperties("/iscsi/target", {
                  name: iscsiName
                });
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi target - code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            } else {
              target = response.body;
            }

            if (!target) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi target`
              );
            }

            this.ctx.logger.verbose("FreeNAS ISCSI TARGET: %j", target);

            // set target.id on zvol
            await zb.zfs.set(datasetName, {
              [FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME]: target.id
            });

            let extent = {
              comment: "",
              type: "DISK", // Disk/File, after save Disk becomes "ZVOL"
              name: iscsiName,
              //iscsi_target_extent_naa: "0x3822690834aae6c5",
              disk: extentDiskName,
              insecure_tpc: extentInsecureTpc,
              xen: extentXenCompat,
              avail_threshold: extentAvailThreshold,
              blocksize: Number(extentBlocksize),
              pblocksize: extentDisablePhysicalBlocksize,
              rpm: "" + extentRpm, // should be a string
              ro: false
            };

            response = await httpClient.post("/iscsi/extent", extent);

            // 409 if invalid
            if (response.statusCode != 200) {
              extent = null;
              if (
                response.statusCode == 422 &&
                JSON.stringify(response.body).includes(
                  "Extent name must be unique"
                )
              ) {
                extent = await this.findResourceByProperties("/iscsi/extent", {
                  name: iscsiName
                });
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi extent - code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            } else {
              extent = response.body;
            }

            if (!extent) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi extent`
              );
            }
            this.ctx.logger.verbose("FreeNAS ISCSI EXTENT: %j", extent);

            await zb.zfs.set(datasetName, {
              [FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME]: extent.id
            });

            // create targettoextent
            let targetToExtent = {
              target: target.id,
              extent: extent.id,
              lunid: 0
            };
            response = await httpClient.post(
              "/iscsi/targetextent",
              targetToExtent
            );

            if (response.statusCode != 200) {
              targetToExtent = null;

              // LUN ID is already being used for this target.
              // Extent is already in this target.
              if (
                response.statusCode == 422 &&
                JSON.stringify(response.body).includes(
                  "Extent is already in this target."
                ) &&
                JSON.stringify(response.body).includes(
                  "LUN ID is already being used for this target."
                )
              ) {
                targetToExtent = await this.findResourceByProperties(
                  "/iscsi/targetextent",
                  {
                    target: target.id,
                    extent: extent.id,
                    lunid: 0
                  }
                );
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi targetextent - code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            } else {
              targetToExtent = response.body;
            }

            if (!targetToExtent) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi targetextent`
              );
            }
            this.ctx.logger.verbose(
              "FreeNAS ISCSI TARGET_TO_EXTENT: %j",
              targetToExtent
            );

            await zb.zfs.set(datasetName, {
              [FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME]: targetToExtent.id
            });

            break;
          default:
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `invalid configuration: unknown apiVersion ${apiVersion}`
            );
        }

        // iqn = target
        let iqn = basename + ":" + iscsiName;
        this.ctx.logger.info("FreeNAS iqn: " + iqn);

        // iscsiadm -m discovery -t st -p 172.21.26.81
        // iscsiadm -m node -T iqn.2011-03.lan.bitness.istgt:test -p bitness.lan -l

        // FROM driver config? no, node attachment should have everything required to remain independent
        // portal
        // portals
        // interface
        // chap discovery
        // chap session

        // FROM context
        // iqn
        // lun

        let volume_context = {
          node_attach_driver: "iscsi",
          portal: this.options.iscsi.targetPortal,
          portals: this.options.iscsi.targetPortals.join(","),
          interface: this.options.iscsi.interface,
          //chapDiscoveryEnabled: this.options.iscsi.chapDiscoveryEnabled,
          //chapSessionEnabled: this.options.iscsi.chapSessionEnabled,
          iqn: iqn,
          lun: 0
        };
        return volume_context;

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driverShareType ${driverShareType}`
        );
    }
  }

  async deleteShare(call, datasetName) {
    const driverShareType = this.getDriverShareType();
    const httpClient = this.getHttpClient();
    const apiVersion = httpClient.getApiVersion();
    const zb = this.getZetabyte();

    let properties;
    let response;
    let endpoint;

    switch (driverShareType) {
      case "nfs":
        try {
          properties = await zb.zfs.get(datasetName, [
            FREENAS_NFS_SHARE_PROPERTY_NAME
          ]);
        } catch (err) {
          if (err.toString().includes("dataset does not exist")) {
            return;
          }
          throw err;
        }
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        let shareId = properties[FREENAS_NFS_SHARE_PROPERTY_NAME].value;

        // remove nfs share
        if (
          properties &&
          properties[FREENAS_NFS_SHARE_PROPERTY_NAME] &&
          properties[FREENAS_NFS_SHARE_PROPERTY_NAME].value != "-"
        ) {
          switch (apiVersion) {
            case 1:
            case 2:
              endpoint = "/sharing/nfs/";
              if (apiVersion == 2) {
                endpoint += "id/";
              }
              endpoint += shareId;

              response = await httpClient.get(endpoint);

              // assume share is gone for now
              if ([500].includes(response.statusCode)) {
              } else {
                response = await httpClient.delete(endpoint);

                // returns a 500 if does not exist
                // v1 = 204
                // v2 = 200
                if (![200, 204].includes(response.statusCode)) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `received error deleting nfs share - share: ${shareId} code: ${
                      response.statusCode
                    } body: ${JSON.stringify(response.body)}`
                  );
                }
              }
              break;
            default:
              throw new GrpcError(
                grpc.status.FAILED_PRECONDITION,
                `invalid configuration: unknown apiVersion ${apiVersion}`
              );
          }
        }
        break;
      case "iscsi":
        // Delete target
        // NOTE: deletting a target inherently deletes associated targetgroup(s) and targettoextent(s)

        // Delete extent
        try {
          properties = await zb.zfs.get(datasetName, [
            FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME,
            FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME,
            FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME
          ]);
        } catch (err) {
          if (err.toString().includes("dataset does not exist")) {
            return;
          }
          throw err;
        }

        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        let targetId = properties[FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME].value;
        let extentId = properties[FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME].value;

        switch (apiVersion) {
          case 1:
          case 2:
            // https://jira.ixsystems.com/browse/NAS-103952

            // v1 - /services/iscsi/target/{id}/
            // v2 - /iscsi/target/id/{id}
            endpoint = "";
            if (apiVersion == 1) {
              endpoint += "/services";
            }
            endpoint += "/iscsi/target/";
            if (apiVersion == 2) {
              endpoint += "id/";
            }
            endpoint += targetId;
            response = await httpClient.get(endpoint);

            // assume is gone for now
            if ([500].includes(response.statusCode)) {
            } else {
              response = await httpClient.delete(endpoint);
              if (![200, 204].includes(response.statusCode)) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error deleting iscsi target - extent: ${targetId} code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            }

            // v1 - /services/iscsi/targettoextent/{id}/
            // v2 - /iscsi/targetextent/id/{id}
            if (apiVersion == 1) {
              endpoint = "/services/iscsi/extent/";
            } else {
              endpoint = "/iscsi/extent/id/";
            }
            endpoint += extentId;
            response = await httpClient.get(endpoint);

            // assume is gone for now
            if ([500].includes(response.statusCode)) {
            } else {
              response = await httpClient.delete(endpoint);
              if (![200, 204].includes(response.statusCode)) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error deleting iscsi extent - extent: ${extentId} code: ${
                    response.statusCode
                  } body: ${JSON.stringify(response.body)}`
                );
              }
            }
            break;
          default:
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `invalid configuration: unknown apiVersion ${apiVersion}`
            );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driverShareType ${driverShareType}`
        );
    }
  }

  async expandVolume(call, datasetName) {
    const driverShareType = this.getDriverShareType();
    const sshClient = this.getSshClient();

    switch (driverShareType) {
      case "iscsi":
        this.ctx.logger.verbose("FreeNAS reloading ctld");
        await sshClient.exec(
          sshClient.buildCommand("/etc/rc.d/ctld", ["reload"])
        );
        break;
    }
  }

  async getApiVersion() {
    const systemVersion = await this.getSystemVersion();

    return 1;
  }

  async getSystemVersion() {
    const httpClient = this.getHttpClient();
    const endpoint = "/system/version/";
    let response;
    const startApiVersion = httpClient.getApiVersion();
    const versionInfo = {};

    httpClient.setApiVersion(2);
    /**
     * FreeNAS-11.2-U5
     */
    try {
      response = await httpClient.get(endpoint);
      if (response.statusCode == 200) {
        versionInfo.v2 = response.body;
      }
    } catch (e) {}

    httpClient.setApiVersion(1);
    /**
     * {"fullversion": "FreeNAS-9.3-STABLE-201503200528", "name": "FreeNAS", "version": "9.3"}
     * {"fullversion": "FreeNAS-11.2-U5 (c129415c52)", "name": "FreeNAS", "version": ""}
     */
    try {
      response = await httpClient.get(endpoint);
      if (response.statusCode == 200) {
        versionInfo.v1 = response.body;
      }
    } catch (e) {}

    // reset apiVersion
    httpClient.setApiVersion(startApiVersion);

    return versionInfo;
  }
}

module.exports.FreeNASDriver = FreeNASDriver;
