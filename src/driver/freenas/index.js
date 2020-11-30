const { ControllerZfsSshBaseDriver } = require("../controller-zfs-ssh");
const { GrpcError, grpc } = require("../../utils/grpc");
const HttpClient = require("./http").Client;

const Handlebars = require("handlebars");

// freenas properties
const FREENAS_NFS_SHARE_PROPERTY_NAME = "democratic-csi:freenas_nfs_share_id";
const FREENAS_SMB_SHARE_PROPERTY_NAME = "democratic-csi:freenas_smb_share_id";
const FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_target_id";
const FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_extent_id";
const FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_targettoextent_id";
const FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_assets_name";
class FreeNASDriver extends ControllerZfsSshBaseDriver {
  /**
   * cannot make this a storage class parameter as storage class/etc context is *not* sent
   * into various calls such as GetControllerCapabilities etc
   */
  getDriverZfsResourceType() {
    switch (this.options.driver) {
      case "freenas-nfs":
      case "truenas-nfs":
      case "freenas-smb":
      case "truenas-smb":
        return "filesystem";
      case "freenas-iscsi":
      case "truenas-iscsi":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  async setZetabyteCustomOptions(options) {
    if (!options.hasOwnProperty("paths")) {
      const majorMinor = await this.getSystemVersionMajorMinor();
      const isScale = await this.getIsScale();
      if (!isScale && Number(majorMinor) >= 12) {
        options.paths = {
          zfs: "/usr/local/sbin/zfs",
          zpool: "/usr/local/sbin/zpool",
          sudo: "/usr/local/bin/sudo",
          chroot: "/usr/sbin/chroot",
        };
      }
    }
  }

  async getHttpClient(autoDetectVersion = true) {
    const client = new HttpClient(this.options.httpConnection);
    client.logger = this.ctx.logger;

    if (autoDetectVersion && !!!this.options.httpConnection.apiVersion) {
      const apiVersion = await this.getApiVersion();
      client.setApiVersion(apiVersion);
    }

    return client;
  }

  getDriverShareType() {
    switch (this.options.driver) {
      case "freenas-nfs":
      case "truenas-nfs":
        return "nfs";
      case "freenas-smb":
      case "truenas-smb":
        return "smb";
      case "freenas-iscsi":
      case "truenas-iscsi":
        return "iscsi";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  async findResourceByProperties(endpoint, match) {
    if (!match || Object.keys(match).length < 1) {
      return;
    }
    const httpClient = await this.getHttpClient();
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
        response.body.some((i) => {
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
    const httpClient = await this.getHttpClient();
    const apiVersion = httpClient.getApiVersion();
    const zb = await this.getZetabyte();

    let properties;
    let endpoint;
    let response;
    let share = {};

    switch (driverShareType) {
      case "nfs":
        properties = await zb.zfs.get(datasetName, [
          "mountpoint",
          FREENAS_NFS_SHARE_PROPERTY_NAME,
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
                    nfs_security: [],
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
                    security: [],
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
                  [FREENAS_NFS_SHARE_PROPERTY_NAME]: response.body.id,
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
                    `received error creating nfs share - code: ${
                      response.statusCode
                    } body: ${JSON.stringify(response.body)}`
                  );
                }
              }

              let volume_context = {
                node_attach_driver: "nfs",
                server: this.options.nfs.shareHost,
                share: properties.mountpoint.value,
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
            share: properties.mountpoint.value,
          };
          return volume_context;
        }
        break;
      case "smb":
        properties = await zb.zfs.get(datasetName, [
          "mountpoint",
          FREENAS_SMB_SHARE_PROPERTY_NAME,
        ]);
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        let smbName;

        if (this.options.smb.nameTemplate) {
          smbName = Handlebars.compile(this.options.smb.nameTemplate)({
            name: call.request.name,
            parameters: call.request.parameters,
          });
        } else {
          smbName = zb.helpers.extractLeafName(datasetName);
        }

        if (this.options.smb.namePrefix) {
          smbName = this.options.smb.namePrefix + smbName;
        }

        if (this.options.smb.nameSuffix) {
          smbName += this.options.smb.nameSuffix;
        }

        smbName = smbName.toLowerCase();

        this.ctx.logger.info(
          "FreeNAS creating smb share with name: " + smbName
        );

        // create smb share
        if (
          !zb.helpers.isPropertyValueSet(
            properties[FREENAS_SMB_SHARE_PROPERTY_NAME].value
          )
        ) {
          /**
           * The only required parameters are:
           * - path
           * - name
           *
           * Note that over time it appears the list of available parameters has increased
           * so in an effort to best support old versions of FreeNAS we should check the
           * presense of each parameter in the config and set the corresponding parameter in
           * the API request *only* if present in the config.
           */
          switch (apiVersion) {
            case 1:
            case 2:
              share = {
                name: smbName,
                path: properties.mountpoint.value,
              };

              let propertyMapping = {
                shareAuxiliaryConfigurationTemplate: "auxsmbconf",
                shareHome: "home",
                shareAllowedHosts: "hostsallow",
                shareDeniedHosts: "hostsdeny",
                shareDefaultPermissions: "default_permissions",
                shareGuestOk: "guestok",
                shareGuestOnly: "guestonly",
                shareShowHiddenFiles: "showhiddenfiles",
                shareRecycleBin: "recyclebin",
                shareBrowsable: "browsable",
                shareAccessBasedEnumeration: "abe",
                shareTimeMachine: "timemachine",
                shareStorageTask: "storage_task",
              };

              for (const key in propertyMapping) {
                if (this.options.smb.hasOwnProperty(key)) {
                  let value;
                  switch (key) {
                    case "shareAuxiliaryConfigurationTemplate":
                      value = Handlebars.compile(
                        this.options.smb.shareAuxiliaryConfigurationTemplate
                      )({
                        name: call.request.name,
                        parameters: call.request.parameters,
                      });
                      break;
                    default:
                      value = this.options.smb[key];
                      break;
                  }
                  share[propertyMapping[key]] = value;
                }
              }

              switch (apiVersion) {
                case 1:
                  endpoint = "/sharing/cifs";

                  // rename keys with cifs_ prefix
                  for (const key in share) {
                    share["cifs_" + key] = share[key];
                    delete share[key];
                  }

                  // convert to comma-separated list
                  if (share.cifs_hostsallow) {
                    share.cifs_hostsallow = share.cifs_hostsallow.join(",");
                  }

                  // convert to comma-separated list
                  if (share.cifs_hostsdeny) {
                    share.cifs_hostsdeny = share.cifs_hostsdeny.join(",");
                  }
                  break;
                case 2:
                  endpoint = "/sharing/smb";
                  break;
              }

              response = await httpClient.post(endpoint, share);

              /**
               * v1 = 201
               * v2 = 200
               */
              if ([200, 201].includes(response.statusCode)) {
                //set zfs property
                await zb.zfs.set(datasetName, {
                  [FREENAS_SMB_SHARE_PROPERTY_NAME]: response.body.id,
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
                    `received error creating smb share - code: ${
                      response.statusCode
                    } body: ${JSON.stringify(response.body)}`
                  );
                }
              }

              let volume_context = {
                node_attach_driver: "smb",
                server: this.options.smb.shareHost,
                share: smbName,
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
            node_attach_driver: "smb",
            server: this.options.smb.shareHost,
            share: smbName,
          };
          return volume_context;
        }
        break;
      case "iscsi":
        properties = await zb.zfs.get(datasetName, [
          FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME,
          FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME,
          FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME,
        ]);
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        let basename;
        let iscsiName;

        if (this.options.iscsi.nameTemplate) {
          iscsiName = Handlebars.compile(this.options.iscsi.nameTemplate)({
            name: call.request.name,
            parameters: call.request.parameters,
          });
        } else {
          iscsiName = zb.helpers.extractLeafName(datasetName);
        }

        if (this.options.iscsi.namePrefix) {
          iscsiName = this.options.iscsi.namePrefix + iscsiName;
        }

        if (this.options.iscsi.nameSuffix) {
          iscsiName += this.options.iscsi.nameSuffix;
        }

        // According to RFC3270, 'Each iSCSI node, whether an initiator or target, MUST have an iSCSI name. Initiators and targets MUST support the receipt of iSCSI names of up to the maximum length of 223 bytes.'
        // https://kb.netapp.com/Advice_and_Troubleshooting/Miscellaneous/What_is_the_maximum_length_of_a_iSCSI_iqn_name
        // https://tools.ietf.org/html/rfc3720
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

        let extentAvailThreshold = this.options.iscsi.hasOwnProperty(
          "extentAvailThreshold"
        )
          ? Number(this.options.iscsi.extentAvailThreshold)
          : null;

        if (!(extentAvailThreshold > 0 && extentAvailThreshold <= 100)) {
          extentAvailThreshold = null;
        }

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
              iscsi_target_alias: "", // TODO: allow template for this
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
                    iscsi_target_name: iscsiName,
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
              [FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME]: target.id,
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
                iscsi_target_initialdigest: "Auto",
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
                        targetGroupConfig.targetGroupInitiatorGroup,
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
              iscsi_target_extent_comment: "", // TODO: allow template for this value
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
              iscsi_target_extent_ro: false,
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
              [FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME]: extent.id,
            });

            // create targettoextent
            let targetToExtent = {
              iscsi_target: target.id,
              iscsi_extent: extent.id,
              iscsi_lunid: 0,
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
                (JSON.stringify(response.body).includes(
                  "Extent is already in this target."
                ) ||
                  JSON.stringify(response.body).includes(
                    "LUN ID is already being used for this target."
                  ))
              ) {
                targetToExtent = await this.findResourceByProperties(
                  "/services/iscsi/targettoextent",
                  {
                    iscsi_target: target.id,
                    iscsi_extent: extent.id,
                    iscsi_lunid: 0,
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
              [FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME]:
                targetToExtent.id,
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
                    : "NONE",
              });
            }
            let target = {
              name: iscsiName,
              alias: null, // cannot send "" error: handler error - driver: FreeNASDriver method: CreateVolume error: {"name":"GrpcError","code":2,"message":"received error creating iscsi target - code: 422 body: {\"iscsi_target_create.alias\":[{\"message\":\"Alias already exists\",\"errno\":22}]}"}
              mode: "ISCSI",
              groups: targetGroups,
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
                  name: iscsiName,
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
              [FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME]: target.id,
            });

            let extent = {
              comment: "", // TODO: allow this to be templated
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
              ro: false,
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
                  name: iscsiName,
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
              [FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME]: extent.id,
            });

            // create targettoextent
            let targetToExtent = {
              target: target.id,
              extent: extent.id,
              lunid: 0,
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
                (JSON.stringify(response.body).includes(
                  "Extent is already in this target."
                ) ||
                  JSON.stringify(response.body).includes(
                    "LUN ID is already being used for this target."
                  ))
              ) {
                targetToExtent = await this.findResourceByProperties(
                  "/iscsi/targetextent",
                  {
                    target: target.id,
                    extent: extent.id,
                    lunid: 0,
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
              [FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME]:
                targetToExtent.id,
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

        // store this off to make delete process more bullet proof
        await zb.zfs.set(datasetName, {
          [FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME]: iscsiName,
        });

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
          interface: this.options.iscsi.interface || "",
          //chapDiscoveryEnabled: this.options.iscsi.chapDiscoveryEnabled,
          //chapSessionEnabled: this.options.iscsi.chapSessionEnabled,
          iqn: iqn,
          lun: 0,
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
    const httpClient = await this.getHttpClient();
    const apiVersion = httpClient.getApiVersion();
    const zb = await this.getZetabyte();

    let properties;
    let response;
    let endpoint;
    let shareId;
    let deleteAsset;
    let sharePaths;

    switch (driverShareType) {
      case "nfs":
        try {
          properties = await zb.zfs.get(datasetName, [
            "mountpoint",
            FREENAS_NFS_SHARE_PROPERTY_NAME,
          ]);
        } catch (err) {
          if (err.toString().includes("dataset does not exist")) {
            return;
          }
          throw err;
        }
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        shareId = properties[FREENAS_NFS_SHARE_PROPERTY_NAME].value;

        // only remove if the process has not succeeded already
        if (zb.helpers.isPropertyValueSet(shareId)) {
          // remove nfs share
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
              if ([404, 500].includes(response.statusCode)) {
              } else {
                switch (apiVersion) {
                  case 1:
                    sharePaths = response.body.nfs_paths;
                    break;
                  case 2:
                    sharePaths = response.body.paths;
                    break;
                }

                deleteAsset = sharePaths.some((value) => {
                  return value == properties.mountpoint.value;
                });

                if (deleteAsset) {
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

                  // remove property to prevent delete race conditions
                  // due to id re-use by FreeNAS/TrueNAS
                  await zb.zfs.inherit(
                    datasetName,
                    FREENAS_NFS_SHARE_PROPERTY_NAME
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
      case "smb":
        try {
          properties = await zb.zfs.get(datasetName, [
            "mountpoint",
            FREENAS_SMB_SHARE_PROPERTY_NAME,
          ]);
        } catch (err) {
          if (err.toString().includes("dataset does not exist")) {
            return;
          }
          throw err;
        }
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        shareId = properties[FREENAS_SMB_SHARE_PROPERTY_NAME].value;

        // only remove if the process has not succeeded already
        if (zb.helpers.isPropertyValueSet(shareId)) {
          // remove smb share
          switch (apiVersion) {
            case 1:
            case 2:
              switch (apiVersion) {
                case 1:
                  endpoint = `/sharing/cifs/${shareId}`;
                  break;
                case 2:
                  endpoint = `/sharing/smb/id/${shareId}`;
                  break;
              }

              response = await httpClient.get(endpoint);

              // assume share is gone for now
              if ([404, 500].includes(response.statusCode)) {
              } else {
                switch (apiVersion) {
                  case 1:
                    sharePaths = [response.body.cifs_path];
                    break;
                  case 2:
                    sharePaths = [response.body.path];
                    break;
                }

                deleteAsset = sharePaths.some((value) => {
                  return value == properties.mountpoint.value;
                });

                if (deleteAsset) {
                  response = await httpClient.delete(endpoint);

                  // returns a 500 if does not exist
                  // v1 = 204
                  // v2 = 200
                  if (![200, 204].includes(response.statusCode)) {
                    throw new GrpcError(
                      grpc.status.UNKNOWN,
                      `received error deleting smb share - share: ${shareId} code: ${
                        response.statusCode
                      } body: ${JSON.stringify(response.body)}`
                    );
                  }

                  // remove property to prevent delete race conditions
                  // due to id re-use by FreeNAS/TrueNAS
                  await zb.zfs.inherit(
                    datasetName,
                    FREENAS_SMB_SHARE_PROPERTY_NAME
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
            FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME,
            FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME,
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
        let iscsiName =
          properties[FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME].value;
        let assetName;

        switch (apiVersion) {
          case 1:
          case 2:
            // only remove if the process has not succeeded already
            if (zb.helpers.isPropertyValueSet(targetId)) {
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
              if ([404, 500].includes(response.statusCode)) {
              } else {
                deleteAsset = true;
                assetName = null;

                // checking if set for backwards compatibility
                if (zb.helpers.isPropertyValueSet(iscsiName)) {
                  switch (apiVersion) {
                    case 1:
                      assetName = response.body.iscsi_target_name;
                      break;
                    case 2:
                      assetName = response.body.name;
                      break;
                  }

                  if (assetName != iscsiName) {
                    deleteAsset = false;
                  }
                }

                if (deleteAsset) {
                  response = await httpClient.delete(endpoint);
                  if (![200, 204].includes(response.statusCode)) {
                    throw new GrpcError(
                      grpc.status.UNKNOWN,
                      `received error deleting iscsi target - extent: ${targetId} code: ${
                        response.statusCode
                      } body: ${JSON.stringify(response.body)}`
                    );
                  }

                  // remove property to prevent delete race conditions
                  // due to id re-use by FreeNAS/TrueNAS
                  await zb.zfs.inherit(
                    datasetName,
                    FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME
                  );
                } else {
                  this.ctx.logger.debug(
                    "not deleting iscsitarget asset as it appears ID %s has been re-used: zfs name - %s, iscsitarget name - %s",
                    targetId,
                    iscsiName,
                    assetName
                  );
                }
              }
            }

            // only remove if the process has not succeeded already
            if (zb.helpers.isPropertyValueSet(extentId)) {
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
              if ([404, 500].includes(response.statusCode)) {
              } else {
                deleteAsset = true;
                assetName = null;

                // checking if set for backwards compatibility
                if (zb.helpers.isPropertyValueSet(iscsiName)) {
                  switch (apiVersion) {
                    case 1:
                      assetName = response.body.iscsi_target_extent_name;
                      break;
                    case 2:
                      assetName = response.body.name;
                      break;
                  }

                  if (assetName != iscsiName) {
                    deleteAsset = false;
                  }
                }

                if (deleteAsset) {
                  response = await httpClient.delete(endpoint);
                  if (![200, 204].includes(response.statusCode)) {
                    throw new GrpcError(
                      grpc.status.UNKNOWN,
                      `received error deleting iscsi extent - extent: ${extentId} code: ${
                        response.statusCode
                      } body: ${JSON.stringify(response.body)}`
                    );
                  }

                  // remove property to prevent delete race conditions
                  // due to id re-use by FreeNAS/TrueNAS
                  await zb.zfs.inherit(
                    datasetName,
                    FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME
                  );
                } else {
                  this.ctx.logger.debug(
                    "not deleting iscsiextent asset as it appears ID %s has been re-used: zfs name - %s, iscsiextent name - %s",
                    extentId,
                    iscsiName,
                    assetName
                  );
                }
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
        const isScale = await this.getIsScale();
        let command;
        let reload = false;
        if (isScale) {
          command = sshClient.buildCommand("systemctl", ["reload", "scst"]);
          reload = true;
        } else {
          command = sshClient.buildCommand("/etc/rc.d/ctld", ["reload"]);
          reload = true;
        }

        if (reload) {
          if (this.getSudoEnabled()) {
            command = (await this.getSudoPath()) + " " + command;
          }

          this.ctx.logger.verbose(
            "FreeNAS reloading iscsi daemon: %s",
            command
          );

          let response = await sshClient.exec(command);
          if (response.code != 0) {
            throw new GrpcError(
              grpc.status.UNKNOWN,
              `error reloading iscsi daemon: ${JSON.stringify(response)}`
            );
          }
        }
        break;
    }
  }

  async getApiVersion() {
    const systemVersion = await this.getSystemVersion();

    if (systemVersion.v2) {
      return 2;
    }

    return 1;
  }

  async getIsFreeNAS() {
    const systemVersion = await this.getSystemVersion();
    let version;

    if (systemVersion.v2) {
      version = systemVersion.v2;
    } else {
      version = systemVersion.v1.fullversion;
    }

    if (version.toLowerCase().includes("freenas")) {
      return true;
    }

    return false;
  }

  async getIsTrueNAS() {
    const systemVersion = await this.getSystemVersion();
    let version;

    if (systemVersion.v2) {
      version = systemVersion.v2;
    } else {
      version = systemVersion.v1.fullversion;
    }

    if (version.toLowerCase().includes("truenas")) {
      return true;
    }

    return false;
  }

  async getIsScale() {
    const systemVersion = await this.getSystemVersion();

    if (systemVersion.v2 && systemVersion.v2.toLowerCase().includes("scale")) {
      return true;
    }

    return false;
  }

  async getSystemVersionMajorMinor() {
    const systemVersion = await this.getSystemVersion();
    let parts;
    let parts_i;
    let version;

    /*
    systemVersion.v2 = "FreeNAS-11.2-U5";
    systemVersion.v2 = "TrueNAS-SCALE-20.11-MASTER-20201127-092915";
    systemVersion.v1 = {
      fullversion: "FreeNAS-9.3-STABLE-201503200528",
      fullversion: "FreeNAS-11.2-U5 (c129415c52)",
    };

    systemVersion.v2 = null;
    */

    if (systemVersion.v2) {
      version = systemVersion.v2;
    } else {
      version = systemVersion.v1.fullversion;
    }

    if (version) {
      parts = version.split("-");
      parts_i = [];
      parts.forEach((value) => {
        let i = value.replace(/[^\d.]/g, "");
        if (i.length > 0) {
          parts_i.push(i);
        }
      });

      // join and resplit to deal with single elements which contain a decimal
      parts_i = parts_i.join(".").split(".");
      parts_i.splice(2);
      return parts_i.join(".");
    }
  }

  async getSystemVersionMajor() {
    const majorMinor = await this.getSystemVersionMajorMinor();
    return majorMinor.split(".")[0];
  }

  async setVersionInfoCache(versionInfo) {
    const driver = this;
    this.cache = this.cache || {};
    this.cache.versionInfo = versionInfo;

    // crude timeout
    setTimeout(function () {
      driver.cache.versionInfo = null;
    }, 60 * 1000);
  }

  async getSystemVersion() {
    this.cache = this.cache || {};
    if (this.cache.versionInfo) {
      return this.cache.versionInfo;
    }

    const httpClient = await this.getHttpClient(false);
    const endpoint = "/system/version/";
    let response;
    const startApiVersion = httpClient.getApiVersion();
    const versionInfo = {};

    httpClient.setApiVersion(2);
    /**
     * FreeNAS-11.2-U5
     * TrueNAS-12.0-RELEASE
     * TrueNAS-SCALE-20.11-MASTER-20201127-092915
     */
    try {
      response = await httpClient.get(endpoint);
      if (response.statusCode == 200) {
        versionInfo.v2 = response.body;
      }

      // return immediately to save on resources and silly requests
      await this.setVersionInfoCache(versionInfo);
      return versionInfo;
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

    await this.setVersionInfoCache(versionInfo);
    return versionInfo;
  }
}

module.exports.FreeNASDriver = FreeNASDriver;
