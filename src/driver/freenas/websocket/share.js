const _ = require("lodash");
const Handlebars = require("handlebars");

const { GrpcError, grpc } = require("../../../utils/grpc");
const GeneralUtils = require("../../../utils/general");

const { ERROR_DATASET_DOES_NOT_EXIST_REGEX } = require("./api");

// freenas properties
const FREENAS_NFS_SHARE_PROPERTY_NAME = "democratic-csi:freenas_nfs_share_id";
const FREENAS_SMB_SHARE_PROPERTY_NAME = "democratic-csi:freenas_smb_share_id";

// iscsi
const FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_target_id";
const FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_extent_id";
const FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_targettoextent_id";
const FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME =
  "democratic-csi:freenas_iscsi_assets_name";

// nvmeof
const FREENAS_NVMEOF_SUBSYSTEM_ID_PROPERTY_NAME =
  "democratic-csi:freenas_nvmeof_subsystem_id";
const FREENAS_NVMEOF_NAMESPACE_ID_PROPERTY_NAME =
  "democratic-csi:freenas_nvmeof_namespace_id";
const FREENAS_NVMEOF_ASSETS_NAME_PROPERTY_NAME =
  "democratic-csi:freenas_nvmeof_assets_name";

/**
 * Helper class to keep common api bits across ssh and api drivers
 */
class FreeNASApiShareHelper {
  /**
   * driver must implement the following methods:
   * - driver.getDriverShareType();
   * - await driver.getTrueNASWebSocketApiClient();
   * - await driver.getZetabyte();
   * - await driver.getMaxZvolNameLength()
   */
  constructor(driver) {
    this.driver = driver;
  }

  /**
   * Check if an error response indicates a target already exists.
   * This method handles variations in TrueNAS API error messages across different API versions.
   *
   * @param {string|Object} responseBody - The HTTP response body (string or object)
   * @returns {boolean} - true if the error indicates target already exists
   */
  isTargetAlreadyExistsError(responseBody) {
    // Extract error message more efficiently
    let errorString = "";

    if (typeof responseBody === "string") {
      errorString = responseBody;
    } else if (responseBody && typeof responseBody === "object") {
      // Try common error message fields first to avoid full JSON.stringify
      errorString =
        responseBody.message ||
        responseBody.error ||
        responseBody.detail ||
        JSON.stringify(responseBody);
    } else {
      return false;
    }

    // Handle multiple variations of the target already exists error message
    const targetExistsPatterns = [
      "Target name already exists", // Original pattern in code (API v1)
      "Target with this name already exists", // Actual TrueNAS error message (API v2)
      "Target\\b.*\\balready\\b.*\\bexists", // Flexible pattern with word boundaries
    ];

    return targetExistsPatterns.some((pattern) => {
      if (pattern.includes("\\")) {
        // Use regex for flexible patterns with word boundaries
        const regex = new RegExp(pattern, "i");
        return regex.test(errorString);
      } else {
        // Use case-insensitive simple string matching for exact patterns
        return errorString.toLowerCase().includes(pattern.toLowerCase());
      }
    });
  }

  /**
   * should create any necessary share resources
   * should set the SHARE_VOLUME_CONTEXT_PROPERTY_NAME propery
   *
   * @param {*} datasetName
   */
  async createShare(call, datasetName) {
    const driver = this.driver;
    const driverShareType = driver.getDriverShareType();
    const apiClient = await driver.getTrueNASWebSocketApiClient();
    const zb = await driver.getZetabyte();

    let volume_context;
    let properties;
    let endpoint;
    let response;
    let share = {};

    switch (driverShareType) {
      case "nfs":
        {
          properties = await apiClient.DatasetGet(datasetName, [
            "mountpoint",
            FREENAS_NFS_SHARE_PROPERTY_NAME,
          ]);
          driver.ctx.logger.debug("zfs props data: %j", properties);

          // create nfs share
          if (
            !zb.helpers.isPropertyValueSet(
              properties[FREENAS_NFS_SHARE_PROPERTY_NAME].value,
            )
          ) {
            let nfsShareComment;
            if (driver.options.nfs.shareCommentTemplate) {
              nfsShareComment = Handlebars.compile(
                driver.options.nfs.shareCommentTemplate,
              )({
                name: call.request.name,
                parameters: call.request.parameters,
                csi: {
                  name: driver.ctx.args.csiName,
                  version: driver.ctx.args.csiVersion,
                },
                zfs: {
                  datasetName: datasetName,
                },
              });
            } else {
              nfsShareComment = `democratic-csi (${driver.ctx.args.csiName}): ${datasetName}`;
            }

            try {
              share = {
                path: properties.mountpoint.value,
                comment: nfsShareComment || "",
                networks: driver.options.nfs.shareAllowedNetworks,
                hosts: driver.options.nfs.shareAllowedHosts,
                ro: false,
                maproot_user: driver.options.nfs.shareMaprootUser,
                maproot_group: driver.options.nfs.shareMaprootGroup,
                mapall_user: driver.options.nfs.shareMapallUser,
                mapall_group: driver.options.nfs.shareMapallGroup,
                security: [],
              };
              response = await GeneralUtils.retry(
                3,
                1000,
                async () => {
                  return await apiClient.NfsShareCreate(share);
                },
                {
                  retryCondition: (err) => {
                    // TODO: change the logic here
                    return false;
                  },
                },
              );

              if (response.path != properties.mountpoint.value) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `FreeNAS responded with incorrect share data: body: ${JSON.stringify(response)}`,
                );
              }

              //set zfs property
              await apiClient.DatasetSet(datasetName, {
                [FREENAS_NFS_SHARE_PROPERTY_NAME]: response.id,
              });
            } catch (err) {
              if (
                err.message.includes(
                  "You can't share same filesystem with all hosts twice.",
                ) ||
                err.message.includes(
                  "Another NFS share already exports this dataset for some network",
                )
              ) {
                let lookupShare = await apiClient.findResourceByProperties(
                  "/sharing/nfs",
                  (item) => {
                    if (item.path && item.path == properties.mountpoint.value) {
                      return true;
                    }
                    return false;
                  },
                );

                if (!lookupShare) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `TrueNAS failed to find matching share`,
                  );
                }

                //set zfs property
                await apiClient.DatasetSet(datasetName, {
                  [FREENAS_NFS_SHARE_PROPERTY_NAME]: lookupShare.id,
                });
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating nfs share - code: ${
                    err.code
                  } body: ${err.message}`,
                );
              }
            }
          }

          volume_context = {
            node_attach_driver: "nfs",
            server: driver.options.nfs.shareHost,
            share: properties.mountpoint.value,
          };
          return volume_context;
        }
        break;
      /**
       * TODO: smb need to be more defensive like iscsi and nfs
       * ensuring the path is valid and the shareName
       */
      case "smb":
        {
          properties = await apiClient.DatasetGet(datasetName, [
            "mountpoint",
            FREENAS_SMB_SHARE_PROPERTY_NAME,
          ]);
          driver.ctx.logger.debug("zfs props data: %j", properties);

          let smbName;

          if (driver.options.smb.nameTemplate) {
            smbName = Handlebars.compile(driver.options.smb.nameTemplate)({
              name: call.request.name,
              parameters: call.request.parameters,
            });
          } else {
            smbName = zb.helpers.extractLeafName(datasetName);
          }

          if (driver.options.smb.namePrefix) {
            smbName = driver.options.smb.namePrefix + smbName;
          }

          if (driver.options.smb.nameSuffix) {
            smbName += driver.options.smb.nameSuffix;
          }

          smbName = smbName.toLowerCase();

          driver.ctx.logger.info(
            "FreeNAS creating smb share with name: " + smbName,
          );

          // create smb share
          if (
            !zb.helpers.isPropertyValueSet(
              properties[FREENAS_SMB_SHARE_PROPERTY_NAME].value,
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

            try {
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
                if (driver.options.smb.hasOwnProperty(key)) {
                  let value;
                  switch (key) {
                    case "shareAuxiliaryConfigurationTemplate":
                      value = Handlebars.compile(
                        driver.options.smb.shareAuxiliaryConfigurationTemplate,
                      )({
                        name: call.request.name,
                        parameters: call.request.parameters,
                      });
                      break;
                    default:
                      value = driver.options.smb[key];
                      break;
                  }
                  share[propertyMapping[key]] = value;
                }
              }

              let topLevelProperties = [
                "purpose",
                "name",
                "path",
                "enabled",
                "comment",
                "readonly",
                "browsable",
                "access_based_share_enumeration",
                "audit",
              ];
              let disallowedOptions = ["abe"];
              share.purpose = "LEGACY_SHARE";
              share.options = {
                purpose: "LEGACY_SHARE",
              };
              for (const key in share) {
                switch (key) {
                  case "options":
                    // ignore
                    break;
                  default:
                    if (!topLevelProperties.includes(key)) {
                      if (!disallowedOptions.includes(key)) {
                        share.options[key] = share[key];
                      }
                      delete share[key];
                    }
                    break;
                }
              }

              response = await GeneralUtils.retry(
                3,
                1000,
                async () => {
                  return await apiClient.SmbShareCreate(share);
                },
                {
                  retryCondition: (err) => {
                    if (err.toString().includes("must be unique")) return false;
                    if (err.toString().includes("already exists")) return false;
                    return true;
                  },
                },
              );

              let sharePath = response.path;
              let shareName = response.name;

              if (shareName != smbName) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `FreeNAS responded with incorrect share data: body: ${JSON.stringify(response)}`,
                );
              }

              if (sharePath != properties.mountpoint.value) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `FreeNAS responded with incorrect share data: body: ${JSON.stringify(response)}`,
                );
              }

              //set zfs property
              await apiClient.DatasetSet(datasetName, {
                [FREENAS_SMB_SHARE_PROPERTY_NAME]: response.id,
              });
            } catch (err) {
              // [EINVAL] sharingsmb_create.name: Share names are case-insensitive and must be unique
              if (
                err.message.includes("A share with this name already exists") ||
                err.message.includes("must be unique")
              ) {
                let lookupShare = await apiClient.findResourceByProperties(
                  "/sharing/smb",
                  (item) => {
                    if (
                      item?.path == properties.mountpoint.value &&
                      item?.name == smbName
                    ) {
                      return true;
                    }
                    return false;
                  },
                );

                if (!lookupShare) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `FreeNAS failed to find matching share`,
                  );
                }

                //set zfs property
                await apiClient.DatasetSet(datasetName, {
                  [FREENAS_SMB_SHARE_PROPERTY_NAME]: lookupShare.id,
                });
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating smb share - code: ${
                    err.code
                  } body: ${err.message}`,
                );
              }
            }
          }

          volume_context = {
            node_attach_driver: "smb",
            server: driver.options.smb.shareHost,
            share: smbName,
          };
          return volume_context;
        }
        break;
      case "iscsi":
        {
          properties = await apiClient.DatasetGet(datasetName, [
            FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME,
            FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME,
            FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME,
          ]);
          driver.ctx.logger.debug("zfs props data: %j", properties);

          let basename;
          let iscsiName;

          if (driver.options.iscsi.nameTemplate) {
            iscsiName = Handlebars.compile(driver.options.iscsi.nameTemplate)({
              name: call.request.name,
              parameters: call.request.parameters,
            });
          } else {
            iscsiName = zb.helpers.extractLeafName(datasetName);
          }

          if (driver.options.iscsi.namePrefix) {
            iscsiName = driver.options.iscsi.namePrefix + iscsiName;
          }

          if (driver.options.iscsi.nameSuffix) {
            iscsiName += driver.options.iscsi.nameSuffix;
          }

          // According to RFC3270, 'Each iSCSI node, whether an initiator or target, MUST have an iSCSI name. Initiators and targets MUST support the receipt of iSCSI names of up to the maximum length of 223 bytes.'
          // https://kb.netapp.com/Advice_and_Troubleshooting/Miscellaneous/What_is_the_maximum_length_of_a_iSCSI_iqn_name
          // https://tools.ietf.org/html/rfc3720
          // https://github.com/SCST-project/scst/blob/master/scst/src/dev_handlers/scst_vdisk.c#L203
          iscsiName = iscsiName.toLowerCase();

          let extentDiskName = "zvol/" + datasetName;
          let maxZvolNameLength = await driver.getMaxZvolNameLength();
          driver.ctx.logger.debug(
            "max zvol name length: %s",
            maxZvolNameLength,
          );

          /**
           * limit is a FreeBSD limitation
           * https://www.ixsystems.com/documentation/freenas/11.2-U5/storage.html#zfs-zvol-config-opts-tab
           */
          if (extentDiskName.length > maxZvolNameLength) {
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `extent disk name cannot exceed ${maxZvolNameLength} characters:  ${extentDiskName}`,
            );
          }

          // https://github.com/SCST-project/scst/blob/master/scst/src/dev_handlers/scst_vdisk.c#L203
          if (iscsiName.length > 64) {
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `extent name cannot exceed 64 characters:  ${iscsiName}`,
            );
          }

          driver.ctx.logger.info(
            "FreeNAS creating iscsi assets with name: " + iscsiName,
          );

          let extentComment;
          if (driver.options.iscsi.extentCommentTemplate) {
            extentComment = Handlebars.compile(
              driver.options.iscsi.extentCommentTemplate,
            )({
              name: call.request.name,
              parameters: call.request.parameters,
              csi: {
                name: driver.ctx.args.csiName,
                version: driver.ctx.args.csiVersion,
              },
              zfs: {
                datasetName: datasetName,
              },
            });
          } else {
            extentComment = "";
          }

          const extentInsecureTpc = driver.options.iscsi.hasOwnProperty(
            "extentInsecureTpc",
          )
            ? driver.options.iscsi.extentInsecureTpc
            : true;

          const extentXenCompat = driver.options.iscsi.hasOwnProperty(
            "extentXenCompat",
          )
            ? driver.options.iscsi.extentXenCompat
            : false;

          const extentBlocksize = driver.options.iscsi.hasOwnProperty(
            "extentBlocksize",
          )
            ? driver.options.iscsi.extentBlocksize
            : 512;

          const extentDisablePhysicalBlocksize =
            driver.options.iscsi.hasOwnProperty(
              "extentDisablePhysicalBlocksize",
            )
              ? driver.options.iscsi.extentDisablePhysicalBlocksize
              : true;

          const extentRpm = driver.options.iscsi.hasOwnProperty("extentRpm")
            ? driver.options.iscsi.extentRpm
            : "SSD";

          let extentAvailThreshold = driver.options.iscsi.hasOwnProperty(
            "extentAvailThreshold",
          )
            ? Number(driver.options.iscsi.extentAvailThreshold)
            : null;

          if (!(extentAvailThreshold > 0 && extentAvailThreshold <= 100)) {
            extentAvailThreshold = null;
          }

          try {
            response = await apiClient.IscsiGlobalConfigGet();
          } catch (err) {
            throw new GrpcError(
              grpc.status.UNKNOWN,
              `error getting iscsi configuration - code: ${
                err.code
              } body: ${JSON.stringify(err.message)}`,
            );
          }

          basename = response.basename;
          driver.ctx.logger.verbose("FreeNAS ISCSI BASENAME: " + basename);

          // if we got all the way to the TARGETTOEXTENT then we fully finished
          // otherwise we must do all assets every time due to the interdependence of IDs etc
          if (
            !zb.helpers.isPropertyValueSet(
              properties[FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME].value,
            )
          ) {
            // create target and targetgroup
            //let targetId;
            let targetGroups = [];
            for (let targetGroupConfig of driver.options.iscsi.targetGroups) {
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
              mode: "ISCSI", // ISCSI, FC, BOTH
              groups: targetGroups,
            };

            try {
              response = await apiClient.IscsiTargetCreate(target);
              target = response;
            } catch (err) {
              target = null;
              if (this.isTargetAlreadyExistsError(err.message)) {
                driver.ctx.logger.debug(
                  "iSCSI target already exists, attempting to find existing target with name: %s",
                  iscsiName,
                );
                target = await apiClient.findResourceByProperties(
                  "/iscsi/target",
                  {
                    name: iscsiName,
                  },
                );
                if (target) {
                  driver.ctx.logger.debug(
                    "Found existing iSCSI target with ID: %s, name: %s",
                    target.id,
                    target.name,
                  );
                }
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi target - code: ${
                    err.code
                  } body: ${JSON.stringify(err.message)}`,
                );
              }
            }

            if (!target) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi target`,
              );
            }

            if (target.name != iscsiName) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `mismatch name error creating iscsi target`,
              );
            }

            // handle situations/race conditions where groups failed to be added/created on the target
            // groups":[{"portal":1,"initiator":1,"auth":null,"authmethod":"NONE"},{"portal":2,"initiator":1,"auth":null,"authmethod":"NONE"}]
            // TODO: this logic could be more intelligent but this should do for now as it appears in the failure scenario no groups are added
            // in other words, I have never seen them invalid, only omitted so this should be enough
            if (target.groups.length != targetGroups.length) {
              try {
                response = await apiClient.IscsiTargetUpdate(
                  `/iscsi/target/id/${target.id}`,
                  {
                    groups: targetGroups,
                  },
                );

                target = response;

                // re-run sanity checks
                if (!target) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `unknown error creating iscsi target`,
                  );
                }

                if (target.name != iscsiName) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `mismatch name error creating iscsi target`,
                  );
                }

                if (target.groups.length != targetGroups.length) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `failed setting target groups`,
                  );
                }
              } catch (err) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `failed setting target groups`,
                );
              }
            }

            driver.ctx.logger.verbose("FreeNAS ISCSI TARGET: %j", target);

            // set target.id on zvol
            await apiClient.DatasetSet(datasetName, {
              [FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME]: target.id,
            });

            let extent = {
              comment: extentComment,
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

            try {
              response = await apiClient.IscsiExtentCreate(extent);
              extent = response;
            } catch (err) {
              extent = null;
              if (String(err.message).includes("Extent name must be unique")) {
                extent = await apiClient.findResourceByProperties(
                  "/iscsi/extent",
                  {
                    name: iscsiName,
                  },
                );
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi extent - code: ${
                    err.code
                  } body: ${JSON.stringify(err.message)}`,
                );
              }
            }

            if (!extent) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi extent`,
              );
            }

            if (extent.name != iscsiName) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `mismatch name error creating iscsi extent`,
              );
            }

            driver.ctx.logger.verbose("FreeNAS ISCSI EXTENT: %j", extent);

            await apiClient.DatasetSet(datasetName, {
              [FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME]: extent.id,
            });

            // create targettoextent
            let targetToExtent = {
              target: target.id,
              extent: extent.id,
              lunid: 0,
            };

            try {
              response =
                await apiClient.IscsiTargetExtentCreate(targetToExtent);
              targetToExtent = response;
            } catch (err) {
              // fill in
              targetToExtent = null;

              // LUN ID is already being used for this target.
              // Extent is already in this target.
              if (
                String(err.message).includes(
                  "Extent is already in this target.",
                ) ||
                String(err.message).includes(
                  "LUN ID is already being used for this target.",
                )
              ) {
                targetToExtent = await apiClient.findResourceByProperties(
                  "/iscsi/targetextent",
                  {
                    target: target.id,
                    extent: extent.id,
                    lunid: 0,
                  },
                );
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error creating iscsi targetextent - code: ${
                    err.code
                  } body: ${JSON.stringify(err.message)}`,
                );
              }
            }

            if (!targetToExtent) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unknown error creating iscsi targetextent`,
              );
            }
            driver.ctx.logger.verbose(
              "FreeNAS ISCSI TARGET_TO_EXTENT: %j",
              targetToExtent,
            );

            await apiClient.DatasetSet(datasetName, {
              [FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME]:
                targetToExtent.id,
            });
          }

          // iqn = target
          let iqn = basename + ":" + iscsiName;
          driver.ctx.logger.info("FreeNAS iqn: " + iqn);

          // store this off to make delete process more bullet proof
          await apiClient.DatasetSet(datasetName, {
            [FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME]: iscsiName,
          });

          volume_context = {
            node_attach_driver: "iscsi",
            portal: driver.options.iscsi.targetPortal || "",
            portals: driver.options.iscsi.targetPortals
              ? driver.options.iscsi.targetPortals.join(",")
              : "",
            interface: driver.options.iscsi.interface || "",
            iqn: iqn,
            lun: 0,
          };
          return volume_context;
        }
        break;

      case "nvmeof":
        {
          properties = await apiClient.DatasetGet(datasetName, [
            FREENAS_NVMEOF_SUBSYSTEM_ID_PROPERTY_NAME,
            FREENAS_NVMEOF_NAMESPACE_ID_PROPERTY_NAME,
            FREENAS_NVMEOF_ASSETS_NAME_PROPERTY_NAME,
          ]);
          driver.ctx.logger.debug("zfs props data: %j", properties);

          let nvmeofName;

          if (driver.options.nvmeof.nameTemplate) {
            nvmeofName = Handlebars.compile(driver.options.nvmeof.nameTemplate)(
              {
                name: call.request.name,
                parameters: call.request.parameters,
              },
            );
          } else {
            nvmeofName = zb.helpers.extractLeafName(datasetName);
          }

          if (driver.options.nvmeof.namePrefix) {
            nvmeofName = driver.options.nvmeof.namePrefix + nvmeofName;
          }

          if (driver.options.nvmeof.nameSuffix) {
            nvmeofName += driver.options.nvmeof.nameSuffix;
          }

          // According to RFC3270, 'Each iSCSI node, whether an initiator or target, MUST have an iSCSI name. Initiators and targets MUST support the receipt of iSCSI names of up to the maximum length of 223 bytes.'
          // https://kb.netapp.com/Advice_and_Troubleshooting/Miscellaneous/What_is_the_maximum_length_of_a_iSCSI_iqn_name
          // https://tools.ietf.org/html/rfc3720
          // https://github.com/SCST-project/scst/blob/master/scst/src/dev_handlers/scst_vdisk.c#L203
          nvmeofName = nvmeofName.toLowerCase();

          let namespaceDiskName = "zvol/" + datasetName;
          let maxZvolNameLength = await driver.getMaxZvolNameLength();
          driver.ctx.logger.debug(
            "max zvol name length: %s",
            maxZvolNameLength,
          );

          if (namespaceDiskName.length > maxZvolNameLength) {
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `namespace disk name cannot exceed ${maxZvolNameLength} characters: ${namespaceDiskName}`,
            );
          }

          // TODO: get basenqn from global config, add nvemofName to it and ensure full nqn is <= 223
          // // https://github.com/SCST-project/scst/blob/master/scst/src/dev_handlers/scst_vdisk.c#L203
          // if (isScale && nvmeofName.length > 64) {
          //   throw new GrpcError(
          //     grpc.status.FAILED_PRECONDITION,
          //     `extent name cannot exceed 64 characters:  ${nvmeofName}`
          //   );
          // }

          driver.ctx.logger.info(
            "FreeNAS creating nvmeof assets with name: " + nvmeofName,
          );

          // http://<ip>/api/docs/current/api_methods_nvmet.subsys.create.html
          let subsystemTemplate = _.get(
            driver.options,
            "nvmeof.subsystemTemplate",
            {},
          );
          subsystemTemplate = subsystemTemplate || {};

          // http://<ip>/api/docs/current/api_methods_nvmet.namespace.create.html
          let namespaceTemplate = _.get(
            driver.options,
            "nvmeof.namespaceTemplate",
            {},
          );
          namespaceTemplate = namespaceTemplate || {};

          // create subsystem
          let subsystem;
          try {
            subsystem = await apiClient.NvmetSubsysCreate({
              ...subsystemTemplate,
              name: nvmeofName,
            });
          } catch (err) {
            if (String(err.message).includes("already exists")) {
              subsystem = await apiClient.findResourceByProperties(
                "nvmet.subsys",
                { name: nvmeofName },
              );
            }
          }

          if (!subsystem) {
            throw new GrpcError(
              grpc.status.NOT_FOUND,
              `unable to find nvmeof subsystem: ${nvmeofName}`,
            );
          }
          driver.ctx.logger.verbose("FreeNAS NVMEOF SUBSYSTEM: %j", subsystem);
          await apiClient.DatasetSet(datasetName, {
            [FREENAS_NVMEOF_SUBSYSTEM_ID_PROPERTY_NAME]: subsystem.id,
          });

          // create subsystem
          let namespace;
          try {
            namespace = await apiClient.NvmetNamespaceCreate({
              ...namespaceTemplate,
              device_type: "ZVOL",
              device_path:
                apiClient.NvmetNamespaceZvolPathNormalized(namespaceDiskName),
              subsys_id: subsystem.id,
            });
          } catch (err) {
            if (String(err.message).includes("already used by subsystem")) {
              namespace = await apiClient.findResourceByProperties(
                "nvmet.namespace",
                (item) => {
                  if (
                    item.device_type == "ZVOL" &&
                    item.device_path ==
                      apiClient.NvmetNamespaceZvolPathNormalized(
                        namespaceDiskName,
                      ) &&
                    item.subsys.id == subsystem.id
                  ) {
                    return true;
                  }
                  return false;
                },
              );
            }
          }

          if (!namespace) {
            throw new GrpcError(
              grpc.status.NOT_FOUND,
              `unable to find nvmeof namespace: ${namespaceDiskName}`,
            );
          }
          driver.ctx.logger.verbose("FreeNAS NVMEOF NAMESPACE: %j", namespace);
          await apiClient.DatasetSet(datasetName, {
            [FREENAS_NVMEOF_NAMESPACE_ID_PROPERTY_NAME]: namespace.id,
          });

          // assign ports to subsystem
          let ports = _.get(driver.options, "nvmeof.ports", []);
          for (const port_i of ports) {
            const port = await apiClient.NvmetPortSubsysCreate(
              port_i,
              subsystem.id,
            );
            driver.ctx.logger.verbose("FreeNAS NVMEOF PORT: %j", port);
          }

          // TODO: assign hosts

          // store this off to make delete process more bullet proof
          await apiClient.DatasetSet(datasetName, {
            [FREENAS_NVMEOF_ASSETS_NAME_PROPERTY_NAME]: nvmeofName,
          });

          volume_context = {
            node_attach_driver: "nvmeof",
            transport: driver.options.nvmeof.transport || "",
            transports: driver.options.nvmeof.transports
              ? driver.options.nvmeof.transports.join(",")
              : "",
            nqn: subsystem.subnqn,
            nsid: namespace.nsid,
          };
          return volume_context;
        }
        break;

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driverShareType ${driverShareType}`,
        );
    }
  }

  async deleteShare(call, datasetName) {
    const driver = this.driver;
    const driverShareType = driver.getDriverShareType();
    const apiClient = await driver.getTrueNASWebSocketApiClient();
    const zb = await driver.getZetabyte();

    let properties;
    let response;
    let endpoint;
    let shareId;
    let deleteAsset;

    switch (driverShareType) {
      case "nfs":
        {
          try {
            properties = await apiClient.DatasetGet(datasetName, [
              "mountpoint",
              FREENAS_NFS_SHARE_PROPERTY_NAME,
            ]);
          } catch (err) {
            if (ERROR_DATASET_DOES_NOT_EXIST_REGEX.test(err.toString())) {
              return;
            }
            throw err;
          }
          driver.ctx.logger.debug("zfs props data: %j", properties);

          shareId = properties[FREENAS_NFS_SHARE_PROPERTY_NAME].value;

          // only remove if the process has not succeeded already
          if (zb.helpers.isPropertyValueSet(shareId)) {
            // remove nfs share

            let share = await apiClient.findResourceByProperties(
              "/sharing/nfs",
              (item) => {
                if (item.id == shareId) {
                  return true;
                }
                return false;
              },
            );

            if (share) {
              deleteAsset = share.path == properties.mountpoint.value;
              if (deleteAsset) {
                try {
                  await GeneralUtils.retry(
                    3,
                    1000,
                    async () => {
                      return await apiClient.NfsShareDelete(shareId);
                    },
                    {
                      retryCondition: (err) => {
                        // TODO: fix this logic
                        return false;
                      },
                    },
                  );
                } catch (err) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `received error deleting nfs share - share: ${shareId} code: ${
                      err.code
                    } body: ${err.message}`,
                  );
                }

                // remove property to prevent delete race conditions
                // due to id re-use by FreeNAS/TrueNAS
                await apiClient.DatasetInherit(
                  datasetName,
                  FREENAS_NFS_SHARE_PROPERTY_NAME,
                );
              }
            } else {
              // assume share is gone for now
            }
          }
        }
        break;
      case "smb":
        {
          try {
            properties = await apiClient.DatasetGet(datasetName, [
              "mountpoint",
              FREENAS_SMB_SHARE_PROPERTY_NAME,
            ]);
          } catch (err) {
            if (ERROR_DATASET_DOES_NOT_EXIST_REGEX.test(err.toString())) {
              return;
            }
            throw err;
          }
          driver.ctx.logger.debug("zfs props data: %j", properties);

          shareId = properties[FREENAS_SMB_SHARE_PROPERTY_NAME].value;

          // only remove if the process has not succeeded already
          if (zb.helpers.isPropertyValueSet(shareId)) {
            // remove smb share
            let share = await apiClient.findResourceByProperties(
              "/sharing/smb",
              (item) => {
                if (item.id == shareId) {
                  return true;
                }
                return false;
              },
            );

            if (share) {
              deleteAsset = share.path == properties.mountpoint.value;
              if (deleteAsset) {
                try {
                  response = await GeneralUtils.retry(
                    3,
                    1000,
                    async () => {
                      return await apiClient.SmbShareDelete(shareId);
                    },
                    {
                      retryCondition: (err) => {
                        // TODO: fix this logic
                        return false;
                      },
                    },
                  );
                } catch (err) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `received error deleting smb share - share: ${shareId} code: ${
                      err.code
                    } body: ${err.message}`,
                  );
                }

                // remove property to prevent delete race conditions
                // due to id re-use by FreeNAS/TrueNAS
                await apiClient.DatasetInherit(
                  datasetName,
                  FREENAS_SMB_SHARE_PROPERTY_NAME,
                );
              }
            } else {
              // assume share is gone for now
            }
          }
        }
        break;
      case "iscsi":
        {
          // Delete target
          // NOTE: deleting a target inherently deletes associated targetgroup(s) and targettoextent(s)

          // Delete extent
          try {
            properties = await apiClient.DatasetGet(datasetName, [
              FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME,
              FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME,
              FREENAS_ISCSI_TARGETTOEXTENT_ID_PROPERTY_NAME,
              FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME,
            ]);
          } catch (err) {
            if (ERROR_DATASET_DOES_NOT_EXIST_REGEX.test(err.toString())) {
              return;
            }
            throw err;
          }

          driver.ctx.logger.debug("zfs props data: %j", properties);

          let targetId =
            properties[FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME].value;
          let extentId =
            properties[FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME].value;
          let iscsiName =
            properties[FREENAS_ISCSI_ASSETS_NAME_PROPERTY_NAME].value;
          let assetName;
          let message;

          // only remove if the process has not succeeded already
          if (zb.helpers.isPropertyValueSet(targetId)) {
            response = null;
            deleteAsset = false;
            assetName = null;
            message = "";

            try {
              response = await apiClient.ResourceGet("iscsi.target", targetId);
              deleteAsset = true;
            } catch (err) {
              if (String(err.message).includes("does not exist")) {
                // assume is gone for now
                message = `not deleting iscsitarget asset as it appears ID ${targetId} has already been deleted: zfs name - ${iscsiName}`;
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error deleting iscsi target - target: ${targetId} code: ${
                    err.code
                  } body: ${JSON.stringify(err.message)}`,
                );
              }
            }

            // checking if set for backwards compatibility
            if (zb.helpers.isPropertyValueSet(iscsiName)) {
              assetName = response.name;
              if (assetName != iscsiName) {
                deleteAsset = false;
                message = `not deleting iscsitarget asset as it appears ID ${targetId} has been re-used: zfs name - ${iscsiName}, iscsitarget name - ${assetName}`;
              }
            }

            if (deleteAsset) {
              try {
                await GeneralUtils.retry(
                  5,
                  1000,
                  async () => {
                    return await apiClient.IscsiTargetDelete(targetId);
                  },
                  {
                    retryCondition: (err) => {
                      // TODO: errno == 14?
                      if (
                        String(err.message).includes("is in use") &&
                        String(err.message).includes("Target")
                      )
                        return true;
                      return false;
                    },
                  },
                );
              } catch (err) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error deleting iscsi target - target: ${targetId} code: ${
                    err.code
                  } body: ${JSON.stringify(err.message)}`,
                );
              }

              // remove property to prevent delete race conditions
              // due to id re-use by FreeNAS/TrueNAS
              await apiClient.DatasetInherit(
                datasetName,
                FREENAS_ISCSI_TARGET_ID_PROPERTY_NAME,
              );
            } else {
              driver.ctx.logger.debug(message);
            }
          }

          // only remove if the process has not succeeded already
          if (zb.helpers.isPropertyValueSet(extentId)) {
            response = null;
            deleteAsset = false;
            assetName = null;
            message = "";

            try {
              response = await apiClient.ResourceGet("iscsi.extent", extentId);
              deleteAsset = true;
            } catch (err) {
              if (String(err.message).includes("does not exist")) {
                // assume is gone for now
                message = `not deleting iscsiextent asset as it appears ID ${extentId} has already been deleted: zfs name - ${iscsiName}`;
              } else {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error deleting iscsi extent - extent: ${extentId} code: ${
                    err.scode
                  } body: ${JSON.stringify(err.message)}`,
                );
              }
            }

            // checking if set for backwards compatibility
            if (zb.helpers.isPropertyValueSet(iscsiName)) {
              assetName = response.name;
              if (assetName != iscsiName) {
                deleteAsset = false;
                message = `not deleting iscsiextent asset as it appears ID ${extentId} has been re-used: zfs name - ${iscsiName}, iscsitarget name - ${assetName}`;
              }
            }

            if (deleteAsset) {
              try {
                await GeneralUtils.retry(
                  5,
                  1000,
                  async () => {
                    return await apiClient.IscsiExtentDelete(extentId);
                  },
                  {
                    retryCondition: (err) => {
                      // TODO: better logic here
                      return false;
                    },
                  },
                );
              } catch (err) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `received error deleting iscsi extent - extent: ${extentId} code: ${
                    err.code
                  } body: ${JSON.stringify(err.message)}`,
                );
              }

              // remove property to prevent delete race conditions
              // due to id re-use by FreeNAS/TrueNAS
              await apiClient.DatasetInherit(
                datasetName,
                FREENAS_ISCSI_EXTENT_ID_PROPERTY_NAME,
              );
            } else {
              driver.ctx.logger.debug(message);
            }
          }
        }
        break;

      case "nvmeof":
        {
          try {
            properties = await apiClient.DatasetGet(datasetName, [
              FREENAS_NVMEOF_SUBSYSTEM_ID_PROPERTY_NAME,
              FREENAS_NVMEOF_NAMESPACE_ID_PROPERTY_NAME,
              FREENAS_NVMEOF_ASSETS_NAME_PROPERTY_NAME,
            ]);
          } catch (err) {
            if (ERROR_DATASET_DOES_NOT_EXIST_REGEX.test(err.toString())) {
              return;
            }
            throw err;
          }
          driver.ctx.logger.debug("zfs props data: %j", properties);

          let subsystemId =
            properties[FREENAS_NVMEOF_SUBSYSTEM_ID_PROPERTY_NAME].value;
          let namespaceId =
            properties[FREENAS_NVMEOF_NAMESPACE_ID_PROPERTY_NAME].value;

          // remove namespace
          if (zb.helpers.isPropertyValueSet(namespaceId)) {
            await GeneralUtils.retry(
              15,
              2000,
              async () => {
                await apiClient.NvmetNamespaceDelete(namespaceId);
              },
              {
                retryCondition: (err) => {
                  return true;
                },
              },
            );

            await apiClient.DatasetInherit(
              datasetName,
              FREENAS_NVMEOF_NAMESPACE_ID_PROPERTY_NAME,
            );
          }

          // remove subsystem
          if (zb.helpers.isPropertyValueSet(subsystemId)) {
            await GeneralUtils.retry(
              15,
              2000,
              async () => {
                await apiClient.NvmetSubsysDelete(subsystemId, {
                  force: true,
                });
              },
              {
                retryCondition: (err) => {
                  return true;
                },
              },
            );

            await apiClient.DatasetInherit(
              datasetName,
              FREENAS_NVMEOF_SUBSYSTEM_ID_PROPERTY_NAME,
            );
          }
        }
        break;

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driverShareType ${driverShareType}`,
        );
    }
  }

  /**
   * Hypothetically this isn't needed. The middleware is supposed to reload stuff as appropriate.
   *
   * @param {*} call
   * @param {*} datasetName
   * @returns
   */
  async expandVolume(call, datasetName) {
    return;
  }
}

module.exports.FreeNASApiShareHelper = FreeNASApiShareHelper;
