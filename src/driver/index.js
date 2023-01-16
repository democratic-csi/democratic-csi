const _ = require("lodash");
const cp = require("child_process");
const os = require("os");
const fs = require("fs");
const CsiProxyClient = require("../utils/csi_proxy_client").CsiProxyClient;
const k8s = require("@kubernetes/client-node");
const { GrpcError, grpc } = require("../utils/grpc");
const { Mount } = require("../utils/mount");
const { OneClient } = require("../utils/oneclient");
const { Filesystem } = require("../utils/filesystem");
const { ISCSI } = require("../utils/iscsi");
const { NVMEoF } = require("../utils/nvmeof");
const registry = require("../utils/registry");
const semver = require("semver");
const GeneralUtils = require("../utils/general");
const { Zetabyte } = require("../utils/zfs");
const { transport } = require("winston");

const __REGISTRY_NS__ = "CsiBaseDriver";

const NODE_OS_DRIVER_CSI_PROXY = "csi-proxy";
const NODE_OS_DRIVER_POSIX = "posix";
const NODE_OS_DRIVER_WINDOWS = "windows";

/**
 * common code shared between all drivers
 * this is **NOT** meant to work as a proxy
 * for the grpc calls meaning, it should not
 * also operate as a facade handling directly
 * the requests to the platform
 */
class CsiBaseDriver {
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options || {};

    if (!this.options.hasOwnProperty("node")) {
      this.options.node = {};
    }

    if (!this.options.node.hasOwnProperty("format")) {
      this.options.node.format = {};
    }

    if (!this.options.node.hasOwnProperty("mount")) {
      this.options.node.mount = {};
    }

    if (!this.options.node.mount.hasOwnProperty("checkFilesystem")) {
      this.options.node.mount.checkFilesystem = {};
    }
  }

  /**
   * abstract way of retrieving values from parameters/secrets
   * in order of preference:
   *  - democratic-csi.org/{instance_id}/{key}
   *  - democratic-csi.org/{driver}/{key}
   *  - {key}
   *
   * @param {*} parameters
   * @param {*} key
   */
  getNormalizedParameterValue(parameters, key, driver, instance_id) {
    const normalized = this.getNormalizedParameters(
      parameters,
      driver,
      instance_id
    );
    return normalized[key];
  }

  getNormalizedParameters(parameters, driver, instance_id) {
    const normalized = JSON.parse(JSON.stringify(parameters));
    const base_key = "democratic-csi.org";
    driver = driver || this.options.driver;
    instance_id = instance_id || this.options.instance_id;

    for (const key in parameters) {
      let normalizedKey;
      let prefixLength;
      if (instance_id && key.startsWith(`${base_key}/${instance_id}/`)) {
        prefixLength = `${base_key}/${instance_id}/`.length;
        normalizedKey = key.slice(prefixLength);
        normalized[normalizedKey] = parameters[key];
        delete normalized[key];
      }

      if (driver && key.startsWith(`${base_key}/${driver}/`)) {
        prefixLength = `${base_key}/${driver}/`.length;
        normalizedKey = key.slice(prefixLength);
        normalized[normalizedKey] = parameters[key];
        delete normalized[key];
      }

      if (key.startsWith(`${base_key}/`)) {
        prefixLength = `${base_key}/`.length;
        normalizedKey = key.slice(prefixLength);
        normalized[normalizedKey] = parameters[key];
        delete normalized[key];
      }
    }

    return normalized;
  }

  /**
   * Get an instance of the Filesystem class
   *
   * @returns Filesystem
   */
  getDefaultFilesystemInstance() {
    return registry.get(
      `${__REGISTRY_NS__}:default_filesystem_instance`,
      () => {
        return new Filesystem();
      }
    );
  }

  /**
   * Get an instance of the Mount class
   *
   * @returns Mount
   */
  getDefaultMountInstance() {
    return registry.get(`${__REGISTRY_NS__}:default_mount_instance`, () => {
      const filesystem = this.getDefaultFilesystemInstance();
      return new Mount({ filesystem });
    });
  }

  /**
   * Get an instance of the ISCSI class
   *
   * @returns ISCSI
   */
  getDefaultISCSIInstance() {
    return registry.get(`${__REGISTRY_NS__}:default_iscsi_instance`, () => {
      return new ISCSI();
    });
  }

  /**
   * Get an instance of the NVMEoF class
   *
   * @returns NVMEoF
   */
  getDefaultNVMEoFInstance() {
    const driver = this;
    return registry.get(`${__REGISTRY_NS__}:default_nvmeof_instance`, () => {
      return new NVMEoF({ logger: driver.ctx.logger });
    });
  }

  getDefaultZetabyteInstance() {
    return registry.get(`${__REGISTRY_NS__}:default_zb_instance`, () => {
      return new Zetabyte({
        idempotent: true,
        paths: {
          zfs: "zfs",
          zpool: "zpool",
          sudo: "sudo",
          chroot: "chroot",
        },
        //logger: driver.ctx.logger,
        executor: {
          spawn: function () {
            const command = `${arguments[0]} ${arguments[1].join(" ")}`;
            return cp.exec(command);
          },
        },
        log_commands: true,
      });
    });
  }

  getDefaultOneClientInstance() {
    return registry.get(`${__REGISTRY_NS__}:default_oneclient_instance`, () => {
      return new OneClient();
    });
  }

  /**
   *
   * @returns CsiProxyClient
   */
  getDefaultCsiProxyClientInstance() {
    return registry.get(`${__REGISTRY_NS__}:default_csi_proxy_instance`, () => {
      const options = {};
      options.services = _.get(this.options, "node.csiProxy.services", {});
      return new CsiProxyClient(options);
    });
  }

  getDefaultKubernetsConfigInstance() {
    return registry.get(
      `${__REGISTRY_NS__}:default_kubernetes_config_instance`,
      () => {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();
        return kc;
      }
    );
  }

  getCsiProxyEnabled() {
    const defaultValue = process.platform == "win32";
    return _.get(this.options, "node.csiProxy.enabled", defaultValue);
  }

  getNodeIsWindows() {
    return process.platform == "win32";
  }

  __getNodeOsDriver() {
    if (this.getNodeIsWindows()) {
      return NODE_OS_DRIVER_WINDOWS;
    }

    //if (this.getNodeIsWindows() || this.getCsiProxyEnabled()) {
    //  return NODE_OS_DRIVER_CSI_PROXY;
    //}

    return NODE_OS_DRIVER_POSIX;
  }

  getMountFlagValue(mount_flags = [], flag = "") {
    for (let i = mount_flags.length - 1; i >= 0; i--) {
      const mount_flag = mount_flags[i];
      if (mount_flag.startsWith(`${flag}=`)) {
        return mount_flag.split("=", 2)[1] || "";
      }
    }
  }

  async getDerivedVolumeContextDriver() {
    const driver = this;
    let d = _.get(driver.options, "_private.csi.volume.volumeContext.driver");
    if (
      !d &&
      (process.env.KUBERNETES_SERVICE_HOST ||
        process.env.KUBERNETES_SERVICE_PORT)
    ) {
      // test for k8s
      d = "kubernetes";
    }

    if (!d) {
      // test for Nomad
    }

    if (!d && process.env.CSI_SANITY == 1) {
      d = "memory";
    }

    return d;
  }

  /**
   * Used predominantly with windows due to limitations with the csi-proxy
   *
   * @param {*} call
   * @returns
   */
  async getDerivedVolumeContext(call) {
    const driver = this;
    const volume_id = call.request.volume_id;
    const d = await driver.getDerivedVolumeContextDriver();
    driver.ctx.logger.debug(`looking up volume_context using driver: ${d}`);
    let volume_context;
    switch (d) {
      case "memory":
        driver.volume_context_cache = driver.volume_context_cache || {};
        volume_context = driver.volume_context_cache[volume_id];
        break;
      case "kubernetes":
        const kc = driver.getDefaultKubernetsConfigInstance();
        const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

        async function findPVByDriverHandle(driver, volumeHandle) {
          if (!driver || !volumeHandle) {
            return;
          }

          let pv;
          let pvs;
          let kcontinue;
          do {
            pvs = await k8sApi.listPersistentVolume(
              undefined,
              undefined,
              kcontinue,
              undefined,
              undefined,
              undefined // limit
            );
            pv = pvs.body.items.find((item) => {
              return (
                item.spec.csi.driver == driver &&
                item.spec.csi.volumeHandle == volumeHandle
              );
            });
            kcontinue = pvs.body.metadata._continue;
          } while (!pv && pvs.body.metadata._continue);

          return pv;
        }

        const pv = await findPVByDriverHandle(
          driver.ctx.args.csiName,
          volume_id
        );
        if (pv) {
          volume_context = pv.spec.csi.volumeAttributes;
        }
        break;
      default:
        throw new Error(`unknow derived volume context driver: ${d}`);
    }

    //if (!volume_context) {
    //  throw new Error(`failed to retrieve volume_context for ${volume_id}`);
    //}

    if (!volume_context) {
      volume_context = _.get(
        driver.options,
        `_private.volume_context.${volume_id}`
      );
    }

    driver.ctx.logger.debug(
      "retrived derived volume_context %j",
      volume_context
    );
    return volume_context;
  }

  /**
   * Should only be used for testing purposes, generally these details should
   * come from a CO or some other stateful storage mechanism
   *
   * @param {*} volume_id
   * @param {*} volume_context
   */
  async setVolumeContextCache(volume_id, volume_context) {
    const driver = this;
    if (process.env.CSI_SANITY == 1) {
      if (!driver.volume_context_cache) {
        driver.volume_context_cache = {};
      }
      if (!driver.volume_context_cache[volume_id]) {
        driver.ctx.logger.debug(
          "setting volume_context_cache %s %j",
          volume_id,
          volume_context
        );
        driver.volume_context_cache[volume_id] = volume_context;
      }
    }
  }

  /**
   * Translates a `name` to a `volume_id`. Generally the purpose is to shorten
   * the value of `volume_id` to play nicely with scenarios that do not support
   * long names (ie: smb share, etc)
   *
   * @param {*} name
   * @returns
   */
  async getVolumeIdFromName(name) {
    const driver = this;
    const strategy = _.get(
      driver.options,
      "_private.csi.volume.idHash.strategy",
      ""
    );
    switch (strategy.toLowerCase()) {
      case "md5":
        return GeneralUtils.md5(name);
      case "crc32":
        return GeneralUtils.crc32(name);
      case "crc16":
        return GeneralUtils.crc16(name);
      default:
        return name;
    }
  }

  async GetPluginInfo(call) {
    return {
      name: this.ctx.args.csiName,
      vendor_version: this.ctx.args.version,
    };
  }

  async GetPluginCapabilities(call) {
    let capabilities;
    const response = {
      capabilities: [],
    };

    //UNKNOWN = 0;
    // CONTROLLER_SERVICE indicates that the Plugin provides RPCs for
    // the ControllerService. Plugins SHOULD provide this capability.
    // In rare cases certain plugins MAY wish to omit the
    // ControllerService entirely from their implementation, but such
    // SHOULD NOT be the common case.
    // The presence of this capability determines whether the CO will
    // attempt to invoke the REQUIRED ControllerService RPCs, as well
    // as specific RPCs as indicated by ControllerGetCapabilities.
    //CONTROLLER_SERVICE = 1;

    // VOLUME_ACCESSIBILITY_CONSTRAINTS indicates that the volumes for
    // this plugin MAY NOT be equally accessible by all nodes in the
    // cluster. The CO MUST use the topology information returned by
    // CreateVolumeRequest along with the topology information
    // returned by NodeGetInfo to ensure that a given volume is
    // accessible from a given node when scheduling workloads.
    //VOLUME_ACCESSIBILITY_CONSTRAINTS = 2;
    capabilities = this.options.service.identity.capabilities.service || [
      "UNKNOWN",
    ];

    capabilities.forEach((item) => {
      response.capabilities.push({
        service: { type: item },
      });
    });

    //UNKNOWN = 0;
    // ONLINE indicates that volumes may be expanded when published to
    // a node. When a Plugin implements this capability it MUST
    // implement either the EXPAND_VOLUME controller capability or the
    // EXPAND_VOLUME node capability or both. When a plugin supports
    // ONLINE volume expansion and also has the EXPAND_VOLUME
    // controller capability then the plugin MUST support expansion of
    // volumes currently published and available on a node. When a
    // plugin supports ONLINE volume expansion and also has the
    // EXPAND_VOLUME node capability then the plugin MAY support
    // expansion of node-published volume via NodeExpandVolume.
    //
    // Example 1: Given a shared filesystem volume (e.g. GlusterFs),
    //   the Plugin may set the ONLINE volume expansion capability and
    //   implement ControllerExpandVolume but not NodeExpandVolume.
    //
    // Example 2: Given a block storage volume type (e.g. EBS), the
    //   Plugin may set the ONLINE volume expansion capability and
    //   implement both ControllerExpandVolume and NodeExpandVolume.
    //
    // Example 3: Given a Plugin that supports volume expansion only
    //   upon a node, the Plugin may set the ONLINE volume
    //   expansion capability and implement NodeExpandVolume but not
    //   ControllerExpandVolume.
    //ONLINE = 1;

    // OFFLINE indicates that volumes currently published and
    // available on a node SHALL NOT be expanded via
    // ControllerExpandVolume. When a plugin supports OFFLINE volume
    // expansion it MUST implement either the EXPAND_VOLUME controller
    // capability or both the EXPAND_VOLUME controller capability and
    // the EXPAND_VOLUME node capability.
    //
    // Example 1: Given a block storage volume type (e.g. Azure Disk)
    //   that does not support expansion of "node-attached" (i.e.
    //   controller-published) volumes, the Plugin may indicate
    //   OFFLINE volume expansion support and implement both
    //   ControllerExpandVolume and NodeExpandVolume.
    //OFFLINE = 2;
    capabilities = this.options.service.identity.capabilities
      .volume_expansion || ["UNKNOWN"];

    capabilities.forEach((item) => {
      response.capabilities.push({
        volume_expansion: { type: item },
      });
    });

    return response;
  }

  async Probe(call) {
    return { ready: { value: true } };
  }

  async ControllerGetCapabilities(call) {
    let capabilities;
    const response = {
      capabilities: [],
    };

    //UNKNOWN = 0;
    //CREATE_DELETE_VOLUME = 1;
    //PUBLISH_UNPUBLISH_VOLUME = 2;
    //LIST_VOLUMES = 3;
    //GET_CAPACITY = 4;
    // Currently the only way to consume a snapshot is to create
    // a volume from it. Therefore plugins supporting
    // CREATE_DELETE_SNAPSHOT MUST support creating volume from
    // snapshot.
    //CREATE_DELETE_SNAPSHOT = 5;
    //LIST_SNAPSHOTS = 6;

    // Plugins supporting volume cloning at the storage level MAY
    // report this capability. The source volume MUST be managed by
    // the same plugin. Not all volume sources and parameters
    // combinations MAY work.
    //CLONE_VOLUME = 7;

    // Indicates the SP supports ControllerPublishVolume.readonly
    // field.
    //PUBLISH_READONLY = 8;

    // See VolumeExpansion for details.
    //EXPAND_VOLUME = 9;
    capabilities = this.options.service.controller.capabilities.rpc || [
      "UNKNOWN",
    ];

    capabilities.forEach((item) => {
      response.capabilities.push({
        rpc: { type: item },
      });
    });

    return response;
  }

  async NodeGetCapabilities(call) {
    let capabilities;
    const response = {
      capabilities: [],
    };

    //UNKNOWN = 0;
    //STAGE_UNSTAGE_VOLUME = 1;
    // If Plugin implements GET_VOLUME_STATS capability
    // then it MUST implement NodeGetVolumeStats RPC
    // call for fetching volume statistics.
    //GET_VOLUME_STATS = 2;
    // See VolumeExpansion for details.
    //EXPAND_VOLUME = 3;
    capabilities = this.options.service.node.capabilities.rpc || ["UNKNOWN"];

    capabilities.forEach((item) => {
      response.capabilities.push({
        rpc: { type: item },
      });
    });

    return response;
  }

  async NodeGetInfo(call) {
    return {
      node_id: process.env.CSI_NODE_ID || os.hostname(),
      max_volumes_per_node: 0,
    };
  }

  /**
   * https://kubernetes-csi.github.io/docs/raw-block.html
   * --feature-gates=BlockVolume=true,CSIBlockVolume=true
   *
   * StagingTargetPath is always a directory even for block volumes
   *
   * NOTE: stage gets called every time publish does
   *
   * @param {*} call
   */
  async NodeStageVolume(call) {
    const driver = this;
    const mount = driver.getDefaultMountInstance();
    const filesystem = driver.getDefaultFilesystemInstance();
    const iscsi = driver.getDefaultISCSIInstance();
    const nvmeof = driver.getDefaultNVMEoFInstance();
    let result;
    let device;
    let block_device_info;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const staging_target_path = call.request.staging_target_path;
    if (!staging_target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `missing staging_target_path`
      );
    }
    const capability = call.request.volume_capability;
    if (!capability || Object.keys(capability).length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capability`);
    }
    const access_type = capability.access_type || "mount";
    const volume_context = call.request.volume_context;
    let fs_type = _.get(capability, "mount.fs_type");
    let mount_flags;
    let volume_mount_group;
    const node_attach_driver = volume_context.node_attach_driver;
    const block_path = staging_target_path + "/block_device";
    const bind_mount_flags = [];
    bind_mount_flags.push("defaults");

    const normalizedSecrets = this.getNormalizedParameters(
      call.request.secrets,
      call.request.volume_context.provisioner_driver,
      call.request.volume_context.provisioner_driver_instance_id
    );

    /*
    let mount_options = await mount.getMountOptions(staging_target_path);
    console.log(mount_options);
    console.log(await mount.getMountOptionValue(mount_options, "stripe"));
    console.log(await mount.getMountOptionPresent(mount_options, "stripee"));
    throw new Error("foobar");
    */

    if (access_type == "mount") {
      mount_flags = capability.mount.mount_flags || [];

      // yaml mount_flags
      if (_.get(driver.options, "node.mount.mount_flags")) {
        mount_flags.push(
          ..._.get(driver.options, "node.mount.mount_flags").split(",")
        );
      }

      // add secrets mount_flags
      if (normalizedSecrets.mount_flags) {
        mount_flags.push(...normalizedSecrets.mount_flags.split(","));
      }

      switch (node_attach_driver) {
        case "oneclient":
          // move along
          break;
        default:
          mount_flags.push("defaults");

          // https://github.com/karelzak/util-linux/issues/1429
          //mount_flags.push("x-democratic-csi.managed");
          //mount_flags.push("x-democratic-csi.staged");
          break;
      }

      if (
        semver.satisfies(driver.ctx.csiVersion, ">=1.5.0") &&
        driver.options.service.node.capabilities.rpc.includes(
          "VOLUME_MOUNT_GROUP"
        )
      ) {
        volume_mount_group = capability.mount.volume_mount_group; // in k8s this is derrived from the fsgroup in the pod security context
      }
    }

    if (call.request.volume_context.provisioner_driver == "node-manual") {
      result = await this.assertCapabilities([capability], node_attach_driver);
      if (!result.valid) {
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `invalid capability: ${result.message}`
        );
      }
    } else {
      result = await this.assertCapabilities([capability]);
      if (!result.valid) {
        throw new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `invalid capability: ${result.message}`
        );
      }
    }

    switch (driver.__getNodeOsDriver()) {
      case NODE_OS_DRIVER_POSIX:
        // csi spec stipulates that staging_target_path is a directory even for block mounts
        result = await filesystem.pathExists(staging_target_path);
        if (!result) {
          await filesystem.mkdir(staging_target_path, ["-p", "-m", "0750"]);
        }

        // get the `device` set
        switch (node_attach_driver) {
          case "nfs":
          case "lustre":
            device = `${volume_context.server}:${volume_context.share}`;
            break;
          case "smb":
            device = `//${volume_context.server}/${volume_context.share}`;

            // if not present add guest
            let has_username = mount_flags.some((element) => {
              element = element.trim().toLowerCase();
              return element.startsWith("username=");
            });

            // prevents driver from hanging on stdin waiting for a password to be entered at the cli
            if (!has_username) {
              let has_guest = mount_flags.some((element) => {
                element = element.trim().toLowerCase();
                return element === "guest";
              });

              if (!has_guest) {
                mount_flags.push("guest");
              }

              if (volume_mount_group) {
                mount_flags.push(`gid=${volume_mount_group}`);
              }
            }
            break;
          case "iscsi":
            let portals = [];
            if (volume_context.portal) {
              portals.push(volume_context.portal.trim());
            }

            if (volume_context.portals) {
              volume_context.portals.split(",").forEach((portal) => {
                portals.push(portal.trim());
              });
            }

            // ensure full portal value
            portals = portals.map((value) => {
              if (!value.includes(":")) {
                value += ":3260";
              }

              return value.trim();
            });

            // ensure unique entries only
            portals = [...new Set(portals)];

            // stores actual device paths after iscsi login
            let iscsiDevices = [];

            // stores configuration of targets/iqn/luns to connect to
            let iscsiConnections = [];
            for (let portal of portals) {
              iscsiConnections.push({
                portal,
                iqn: volume_context.iqn,
                lun: volume_context.lun,
              });
            }

            /**
             * TODO: allow sending in iscsiConnection in a raw/manual format
             * TODO: allow option to determine if send_targets should be invoked
             * TODO: allow option to control whether nodedb entry should be created by driver
             * TODO: allow option to control whether nodedb entry should be deleted by driver
             */

            for (let iscsiConnection of iscsiConnections) {
              // create DB entry
              // https://library.netapp.com/ecmdocs/ECMP1654943/html/GUID-8EC685B4-8CB6-40D8-A8D5-031A3899BCDC.html
              // put these options in place to force targets managed by csi to be explicitly attached (in the case of unclearn shutdown etc)
              let nodeDB = {
                "node.startup": "manual",
                //"node.session.scan": "manual",
              };
              const nodeDBKeyPrefix = "node-db.";
              for (const key in normalizedSecrets) {
                if (key.startsWith(nodeDBKeyPrefix)) {
                  nodeDB[key.substr(nodeDBKeyPrefix.length)] =
                    normalizedSecrets[key];
                }
              }

              // create 'DB' entry
              await GeneralUtils.retry(5, 2000, async () => {
                await iscsi.iscsiadm.createNodeDBEntry(
                  iscsiConnection.iqn,
                  iscsiConnection.portal,
                  nodeDB
                );
              });

              // login
              await GeneralUtils.retry(15, 2000, async () => {
                await iscsi.iscsiadm.login(
                  iscsiConnection.iqn,
                  iscsiConnection.portal
                );
              });

              // get associated session
              let session = await iscsi.iscsiadm.getSession(
                iscsiConnection.iqn,
                iscsiConnection.portal
              );

              if (!session) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `unable to find iscsi session for iqn: ${iscsiConnection.iqn}, portal: ${iscsiConnection.portal}`
                );
              }

              // rescan in scenarios when login previously occurred but volumes never appeared
              await iscsi.iscsiadm.rescanSession(session);

              // find device name
              device = iscsi.devicePathByPortalIQNLUN(
                iscsiConnection.portal,
                iscsiConnection.iqn,
                iscsiConnection.lun
              );
              let deviceByPath = device;

              // can take some time for device to show up, loop for some period
              result = await filesystem.pathExists(device);
              let timer_start = Math.round(new Date().getTime() / 1000);
              let timer_max = 30;
              let deviceCreated = result;
              while (!result) {
                await GeneralUtils.sleep(2000);
                result = await filesystem.pathExists(device);

                if (result) {
                  deviceCreated = true;
                  break;
                }

                let current_time = Math.round(new Date().getTime() / 1000);
                if (!result && current_time - timer_start > timer_max) {
                  driver.ctx.logger.warn(
                    `hit timeout waiting for device node to appear: ${device}`
                  );
                  break;
                }
              }

              if (deviceCreated) {
                device = await filesystem.realpath(device);
                iscsiDevices.push(device);

                driver.ctx.logger.info(
                  `successfully logged into portal ${iscsiConnection.portal} and created device ${deviceByPath} with realpath ${device}`
                );
              }
            }

            // let things settle
            // this will help in dm scenarios
            await GeneralUtils.sleep(2000);

            // filter duplicates
            iscsiDevices = iscsiDevices.filter((value, index, self) => {
              return self.indexOf(value) === index;
            });

            // only throw an error if we were not able to attach to *any* devices
            if (iscsiDevices.length < 1) {
              throw new GrpcError(
                grpc.status.UNKNOWN,
                `unable to attach any iscsi devices`
              );
            }

            if (iscsiDevices.length != iscsiConnections.length) {
              driver.ctx.logger.warn(
                `failed to attach all iscsi devices/targets/portals`
              );

              // TODO: allow a parameter to control this behavior in some form
              if (false) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `unable to attach all iscsi devices`
                );
              }
            }

            // compare all device-mapper slaves with the newly created devices
            // if any of the new devices are device-mapper slaves treat this as a
            // multipath scenario
            let allDeviceMapperSlaves =
              await filesystem.getAllDeviceMapperSlaveDevices();
            let commonDevices = allDeviceMapperSlaves.filter((value) =>
              iscsiDevices.includes(value)
            );

            const useMultipath =
              iscsiConnections.length > 1 || commonDevices.length > 0;

            // discover multipath device to use
            if (useMultipath) {
              device = await filesystem.getDeviceMapperDeviceFromSlaves(
                iscsiDevices,
                false
              );

              if (!device) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `failed to discover multipath device`
                );
              }
            }

            break;

          case "nvmeof":
            {
              let transports = [];
              if (volume_context.transport) {
                transports.push(volume_context.transport.trim());
              }

              if (volume_context.transports) {
                volume_context.transports.split(",").forEach((transport) => {
                  transports.push(transport.trim());
                });
              }

              // ensure unique entries only
              transports = [...new Set(transports)];

              // stores actual device paths after nvmeof login
              let nvmeofControllerDevices = [];
              let nvmeofNamespaceDevices = [];

              // stores configuration of targets/iqn/luns to connect to
              let nvmeofConnections = [];
              for (let transport of transports) {
                nvmeofConnections.push({
                  transport,
                  nqn: volume_context.nqn,
                  nsid: volume_context.nsid,
                });
              }

              for (let nvmeofConnection of nvmeofConnections) {
                // connect
                try {
                  await GeneralUtils.retry(15, 2000, async () => {
                    await nvmeof.connectByNQNTransport(
                      nvmeofConnection.nqn,
                      nvmeofConnection.transport
                    );
                  });
                } catch (err) {
                  driver.ctx.logger.warn(
                    `error: ${JSON.stringify(err)} connecting to transport: ${
                      nvmeofConnection.transport
                    }`
                  );
                  continue;
                }

                // find controller device
                let controllerDevice;
                try {
                  await GeneralUtils.retry(15, 2000, async () => {
                    controllerDevice =
                      await nvmeof.controllerDevicePathByTransportNQN(
                        nvmeofConnection.transport,
                        nvmeofConnection.nqn,
                        nvmeofConnection.nsid
                      );

                    if (!controllerDevice) {
                      throw new Error(`failed to find controller device`);
                    }
                  });
                } catch (err) {
                  driver.ctx.logger.warn(
                    `error finding nvme controller device: ${JSON.stringify(
                      err
                    )}`
                  );
                  continue;
                }

                // find namespace device
                let namespaceDevice;
                try {
                  await GeneralUtils.retry(15, 2000, async () => {
                    // rescan in scenarios when login previously occurred but volumes never appeared
                    // must be the NVMe char device, not the namespace device
                    await nvmeof.rescanNamespace(controllerDevice);

                    namespaceDevice =
                      await nvmeof.namespaceDevicePathByTransportNQNNamespace(
                        nvmeofConnection.transport,
                        nvmeofConnection.nqn,
                        nvmeofConnection.nsid
                      );
                    if (!controllerDevice) {
                      throw new Error(`failed to find namespace device`);
                    }
                  });
                } catch (err) {
                  driver.ctx.logger.warn(
                    `error finding nvme namespace device: ${JSON.stringify(
                      err
                    )}`
                  );
                  continue;
                }

                // sanity check for device files
                if (!namespaceDevice) {
                  continue;
                }

                // sanity check for device files
                if (!controllerDevice) {
                  continue;
                }

                // can take some time for device to show up, loop for some period
                result = await filesystem.pathExists(namespaceDevice);
                let timer_start = Math.round(new Date().getTime() / 1000);
                let timer_max = 30;
                let deviceCreated = result;
                while (!result) {
                  await GeneralUtils.sleep(2000);
                  result = await filesystem.pathExists(namespaceDevice);

                  if (result) {
                    deviceCreated = true;
                    break;
                  }

                  let current_time = Math.round(new Date().getTime() / 1000);
                  if (!result && current_time - timer_start > timer_max) {
                    driver.ctx.logger.warn(
                      `hit timeout waiting for namespace device node to appear: ${namespaceDevice}`
                    );
                    break;
                  }
                }

                if (deviceCreated) {
                  device = await filesystem.realpath(namespaceDevice);
                  nvmeofControllerDevices.push(controllerDevice);
                  nvmeofNamespaceDevices.push(namespaceDevice);

                  driver.ctx.logger.info(
                    `successfully logged into nvmeof transport ${nvmeofConnection.transport} and created controller device: ${controllerDevice}, namespace device: ${namespaceDevice}`
                  );
                }
              }

              // let things settle
              // this will help in dm scenarios
              await GeneralUtils.sleep(2000);

              // filter duplicates
              nvmeofNamespaceDevices = nvmeofNamespaceDevices.filter(
                (value, index, self) => {
                  return self.indexOf(value) === index;
                }
              );

              nvmeofControllerDevices = nvmeofControllerDevices.filter(
                (value, index, self) => {
                  return self.indexOf(value) === index;
                }
              );

              // only throw an error if we were not able to attach to *any* devices
              if (nvmeofNamespaceDevices.length < 1) {
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `unable to attach any nvme devices`
                );
              }

              if (nvmeofControllerDevices.length != nvmeofConnections.length) {
                driver.ctx.logger.warn(
                  `failed to attach all nvmeof devices/subsystems/transports`
                );

                // TODO: allow a parameter to control this behavior in some form
                if (false) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `unable to attach all iscsi devices`
                  );
                }
              }

              /**
               * NVMEoF has native multipath capabilities without using device mapper
               * You can disable the built-in using kernel param nvme_core.multipath=N/Y
               */
              let useNativeMultipath = await nvmeof.nativeMultipathEnabled();

              if (useNativeMultipath) {
                // only throw an error if we were not able to attach to *any* devices
                if (nvmeofNamespaceDevices.length > 1) {
                  throw new GrpcError(
                    grpc.status.UNKNOWN,
                    `too many nvme namespace devices, native multipath enabled therefore should only have 1`
                  );
                }
              } else {
                // compare all device-mapper slaves with the newly created devices
                // if any of the new devices are device-mapper slaves treat this as a
                // multipath scenario
                let allDeviceMapperSlaves =
                  await filesystem.getAllDeviceMapperSlaveDevices();
                let commonDevices = allDeviceMapperSlaves.filter((value) =>
                  nvmeofNamespaceDevices.includes(value)
                );

                const useDMMultipath =
                  nvmeofConnections.length > 1 || commonDevices.length > 0;

                // discover multipath device to use
                if (useDMMultipath) {
                  device = await filesystem.getDeviceMapperDeviceFromSlaves(
                    nvmeofNamespaceDevices,
                    false
                  );

                  if (!device) {
                    throw new GrpcError(
                      grpc.status.UNKNOWN,
                      `failed to discover multipath device`
                    );
                  }
                } else {
                  // only throw an error if we were not able to attach to *any* devices
                  if (nvmeofNamespaceDevices.length > 1) {
                    throw new GrpcError(
                      grpc.status.UNKNOWN,
                      `too many nvme namespace devices, neither DM nor native multipath enabled`
                    );
                  }
                }
              }
            }
            break;

          case "hostpath":
            result = await mount.pathIsMounted(staging_target_path);
            // if not mounted, mount
            if (!result) {
              await mount.bindMount(volume_context.path, staging_target_path);
              return {};
            } else {
              return {};
            }

            break;
          case "oneclient":
            let oneclient = driver.getDefaultOneClientInstance();
            device = "oneclient";
            result = await mount.deviceIsMountedAtPath(
              device,
              staging_target_path
            );
            if (result) {
              return {};
            }

            if (volume_context.space_names) {
              volume_context.space_names.split(",").forEach((space) => {
                mount_flags.push("--space", space);
              });
            }

            if (volume_context.space_ids) {
              volume_context.space_ids.split(",").forEach((space) => {
                mount_flags.push("--space-id", space);
              });
            }

            if (normalizedSecrets.token) {
              mount_flags.push("-t", normalizedSecrets.token);
            } else {
              if (volume_context.token) {
                mount_flags.push("-t", volume_context.token);
              }
            }

            result = await oneclient.mount(
              staging_target_path,
              ["-H", volume_context.server].concat(mount_flags)
            );

            if (result) {
              return {};
            }

            throw new GrpcError(
              grpc.status.UNKNOWN,
              `failed to mount oneclient: ${volume_context.server}`
            );

            break;
          case "zfs-local":
            // TODO: make this a geneic zb instance (to ensure works with node-manual driver)
            const zb = driver.getDefaultZetabyteInstance();
            result = await zb.zfs.get(`${volume_context.zfs_asset_name}`, [
              "type",
              "mountpoint",
            ]);
            result = result[`${volume_context.zfs_asset_name}`];
            switch (result.type.value) {
              case "filesystem":
                if (result.mountpoint.value != "legacy") {
                  // zfs set mountpoint=legacy <dataset>
                  // zfs inherit mountpoint <dataset>
                  await zb.zfs.set(`${volume_context.zfs_asset_name}`, {
                    mountpoint: "legacy",
                  });
                }
                device = `${volume_context.zfs_asset_name}`;
                if (!fs_type) {
                  fs_type = "zfs";
                }
                break;
              case "volume":
                device = `/dev/zvol/${volume_context.zfs_asset_name}`;
                break;
              default:
                throw new GrpcError(
                  grpc.status.UNKNOWN,
                  `unknown zfs asset type: ${result.type.value}`
                );
            }
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }

        // deal with `device` now that we have one
        switch (access_type) {
          case "mount":
            let is_block = false;
            switch (node_attach_driver) {
              case "iscsi":
              case "nvmeof":
                is_block = true;
                break;
              case "zfs-local":
                is_block = device.startsWith("/dev/zvol/");
                break;
            }

            // format device
            if (is_block) {
              // block specific logic
              if (!fs_type) {
                fs_type = "ext4";
              }

              let partition_count =
                await filesystem.getBlockDevicePartitionCount(device);
              if (partition_count > 0) {
                // data partion MUST be the last partition on the drive
                // to properly support expand/resize operations
                device = await filesystem.getBlockDeviceLastPartition(device);
                driver.ctx.logger.debug(
                  `device has partitions, mount device is: ${device}`
                );

                await filesystem.expandPartition(device);
              }

              if (fs_type == "ntfs") {
                if (partition_count < 1) {
                  // gpt is what csi-proxy uses by default
                  let ntfs_partition_label = "gpt";
                  switch (ntfs_partition_label.toLowerCase()) {
                    case "dos":
                      // partion dos
                      await filesystem.partitionDevice(device, "dos", "07");
                      break;
                    case "gpt":
                      // partion gpt
                      await filesystem.partitionDeviceWindows(device);
                      break;
                    default:
                      throw new GrpcError(
                        grpc.status.INVALID_ARGUMENT,
                        `unknown/unsupported ntfs_partition_label: ${ntfs_partition_label}`
                      );
                  }
                  device = await filesystem.getBlockDeviceLargestPartition(
                    device
                  );
                }
              }

              if (await filesystem.isBlockDevice(device)) {
                // format
                result = await filesystem.deviceIsFormatted(device);
                if (!result) {
                  let formatOptions = _.get(
                    driver.options.node.format,
                    [fs_type, "customOptions"],
                    []
                  );
                  if (!Array.isArray(formatOptions)) {
                    formatOptions = [];
                  }

                  switch (fs_type) {
                    case "ext3":
                    case "ext4":
                    case "ext4dev":
                      // disable reserved blocks in this scenario
                      formatOptions.unshift("-m", "0");
                      break;
                  }

                  await filesystem.formatDevice(device, fs_type, formatOptions);
                }

                let fs_info = await filesystem.getDeviceFilesystemInfo(device);
                fs_type = fs_info.type;

                // fsck
                result = await mount.deviceIsMountedAtPath(
                  device,
                  staging_target_path
                );
                if (!result) {
                  // https://github.com/democratic-csi/democratic-csi/issues/52#issuecomment-768463401
                  let checkFilesystem =
                    driver.options.node.mount.checkFilesystem[fs_type] || {};
                  if (checkFilesystem.enabled) {
                    await filesystem.checkFilesystem(
                      device,
                      fs_type,
                      checkFilesystem.customOptions || [],
                      checkFilesystem.customFilesystemOptions || []
                    );
                  }
                }
              }
            }

            // set default fs_type if still unset
            if (!fs_type) {
              switch (node_attach_driver) {
                case "nfs":
                  fs_type = "nfs";
                  break;
                case "lustre":
                  fs_type = "lustre";
                  break;
                case "smb":
                  fs_type = "cifs";
                  break;
                case "iscsi":
                case "nvmeof":
                  fs_type = "ext4";
                  break;
                default:
                  break;
              }
            }

            // mount `device`
            result = await mount.deviceIsMountedAtPath(
              device,
              staging_target_path
            );
            if (!result) {
              // expand fs if necessary
              if (await filesystem.isBlockDevice(device)) {
                // go ahead and expand fs (this covers cloned setups where expand is not explicitly invoked)
                switch (fs_type) {
                  case "exfat":
                  case "ntfs":
                  case "vfat":
                    //await filesystem.checkFilesystem(device, fs_info.type);
                    await filesystem.expandFilesystem(device, fs_type);
                    break;
                }
              }

              let mount_fs_type = fs_type;
              if (mount_fs_type == "ntfs") {
                mount_fs_type = "ntfs3";
              }

              // handle volume_mount_group where appropriate
              if (volume_mount_group) {
                switch (fs_type) {
                  case "exfat":
                  case "ntfs":
                  case "vfat":
                    mount_flags.push(`gid=${volume_mount_group}`);
                    break;
                }
              }

              switch (fs_type) {
                case "xfs":
                  // https://github.com/democratic-csi/democratic-csi/issues/191
                  // to avoid issues with cloned volumes
                  mount_flags.push(`nouuid`);
                  break;
              }

              await mount.mount(
                device,
                staging_target_path,
                ["-t", mount_fs_type].concat(["-o", mount_flags.join(",")])
              );
            }

            // expand fs if necessary
            if (await filesystem.isBlockDevice(device)) {
              // go ahead and expand fs (this covers cloned setups where expand is not explicitly invoked)
              switch (fs_type) {
                case "ext3":
                case "ext4":
                case "ext4dev":
                  //await filesystem.checkFilesystem(device, fs_info.type);
                  try {
                    await filesystem.expandFilesystem(device, fs_type);
                  } catch (err) {
                    // mount is clean and rw, but it will not expand until clean umount has been done
                    // failed to execute filesystem command: resize2fs /dev/sda, response: {"code":1,"stdout":"Couldn't find valid filesystem superblock.\n","stderr":"resize2fs 1.44.5 (15-Dec-2018)\nresize2fs: Superblock checksum does not match superblock while trying to open /dev/sda\n"}
                    // /dev/sda on /var/lib/kubelet/plugins/kubernetes.io/csi/pv/pvc-4a80757e-5e87-475d-826f-44fcc4719348/globalmount type ext4 (rw,relatime,stripe=256)
                    if (
                      err.code == 1 &&
                      err.stdout.includes("find valid filesystem superblock") &&
                      err.stderr.includes("checksum does not match superblock")
                    ) {
                      driver.ctx.logger.warn(
                        `successful mount, unsuccessful fs resize: attempting abnormal umount/mount/resize2fs to clear things up ${staging_target_path} (${device})`
                      );

                      // try an unmount/mount/fsck cycle again just to clean things up
                      await mount.umount(staging_target_path, []);
                      await mount.mount(
                        device,
                        staging_target_path,
                        ["-t", fs_type].concat(["-o", mount_flags.join(",")])
                      );
                      await filesystem.expandFilesystem(device, fs_type);
                    } else {
                      throw err;
                    }
                  }
                  break;
                case "btrfs":
                case "xfs":
                  //await filesystem.checkFilesystem(device, fs_info.type);
                  await filesystem.expandFilesystem(
                    staging_target_path,
                    fs_type
                  );
                  break;
                case "exfat":
                case "ntfs":
                case "vfat":
                  // noop
                  break;
                default:
                  // unsupported filesystem
                  throw new GrpcError(
                    grpc.status.FAILED_PRECONDITION,
                    `unsupported/unknown filesystem ${fs_type}`
                  );
              }
            }

            break;
          case "block":
            //result = await mount.deviceIsMountedAtPath(device, block_path);
            result = await mount.deviceIsMountedAtPath("dev", block_path);
            if (!result) {
              result = await filesystem.pathExists(staging_target_path);
              if (!result) {
                await filesystem.mkdir(staging_target_path, [
                  "-p",
                  "-m",
                  "0750",
                ]);
              }

              result = await filesystem.pathExists(block_path);
              if (!result) {
                await filesystem.touch(block_path);
              }

              await mount.bindMount(device, block_path, [
                "-o",
                bind_mount_flags.join(","),
              ]);
            }
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported access_type: ${access_type}`
            );
        }
        break;
      case NODE_OS_DRIVER_WINDOWS:
        // sanity check node_attach_driver
        if (!["smb", "iscsi", "hostpath"].includes(node_attach_driver)) {
          throw new GrpcError(
            grpc.status.UNIMPLEMENTED,
            `windows does not work with node_attach_driver: ${node_attach_driver}`
          );
        }

        // sanity check fs_type
        if (fs_type && !["ntfs", "cifs"].includes(fs_type)) {
          throw new GrpcError(
            grpc.status.UNIMPLEMENTED,
            `windows does not work with fs_type: ${fs_type}`
          );
        }

        const WindowsUtils = require("../utils/windows").Windows;
        const wutils = new WindowsUtils();
        let win_staging_target_path =
          filesystem.covertUnixSeparatorToWindowsSeparator(staging_target_path);

        switch (node_attach_driver) {
          case "smb":
            device = `//${volume_context.server}/${volume_context.share}`;
            const username = driver.getMountFlagValue(mount_flags, "username");
            const password = driver.getMountFlagValue(mount_flags, "password");

            if (!username || !password) {
              throw new Error("username and password required");
            }

            /**
             * smb mount creates a link at this location and if the dir already exists
             * it explodes
             *
             * if path exists but is NOT symlink delete it
             */
            result = await filesystem.pathExists(win_staging_target_path);

            if (result) {
              if (!(await filesystem.isSymbolicLink(win_staging_target_path))) {
                fs.rmdirSync(win_staging_target_path);
              } else {
                result = await wutils.GetItem(win_staging_target_path);
                // UNC\172.29.0.111\tank_k8s_test_PVC_111\
                let target = _.get(result, "Target.[0]", "");
                let parts = target.split("\\");
                if (
                  parts[1] != volume_context.server &&
                  parts[2] != volume_context.share
                ) {
                  throw new Error(
                    `${target} mounted already at ${win_staging_target_path}`
                  );
                } else {
                  // finish early, assured we have what we need
                  return {};
                }
              }
            }

            try {
              result = await wutils.GetSmbGlobalMapping(
                filesystem.covertUnixSeparatorToWindowsSeparator(device)
              );
              if (!result) {
                // check for mount option cache=none and set -UseWriteThrough $true
                await wutils.NewSmbGlobalMapping(
                  filesystem.covertUnixSeparatorToWindowsSeparator(device),
                  `${volume_context.server}\\${username}`,
                  password
                );
              }
            } catch (e) {
              let details = _.get(e, "stderr", "");
              if (!details.includes("0x80041001")) {
                throw e;
              }
            }
            try {
              await wutils.NewSmbLink(
                filesystem.covertUnixSeparatorToWindowsSeparator(device),
                win_staging_target_path
              );
            } catch (e) {
              let details = _.get(e, "stderr", "");
              if (!details.includes("ResourceExists")) {
                throw e;
              } else {
                if (
                  !(await filesystem.isSymbolicLink(win_staging_target_path))
                ) {
                  throw new Error("staging path exists but is not symlink");
                }
              }
            }
            break;
          case "iscsi":
            switch (access_type) {
              case "mount":
                let portals = [];
                if (volume_context.portal) {
                  portals.push(volume_context.portal.trim());
                }

                if (volume_context.portals) {
                  volume_context.portals.split(",").forEach((portal) => {
                    portals.push(portal.trim());
                  });
                }

                // ensure full portal value
                portals = portals.map((value) => {
                  if (!value.includes(":")) {
                    value += ":3260";
                  }

                  return value.trim();
                });

                // ensure unique entries only
                portals = [...new Set(portals)];

                // stores configuration of targets/iqn/luns to connect to
                let iscsiConnections = [];
                for (let portal of portals) {
                  iscsiConnections.push({
                    portal,
                    iqn: volume_context.iqn,
                    lun: volume_context.lun,
                  });
                }

                let successful_logins = 0;
                let multipath = iscsiConnections.length > 1;

                // no multipath support yet
                // https://github.com/kubernetes-csi/csi-proxy/pull/99
                for (let iscsiConnection of iscsiConnections) {
                  // add target portal
                  let parts = iscsiConnection.portal.split(":");
                  let target_address = parts[0];
                  let target_port = parts[1] || "3260";

                  // this is idempotent
                  try {
                    await wutils.NewIscsiTargetPortal(
                      target_address,
                      target_port
                    );
                  } catch (e) {
                    driver.ctx.logger.warn(
                      `failed adding target portal: ${JSON.stringify(
                        iscsiConnection
                      )}: ${e.stderr}`
                    );
                    if (!multipath) {
                      throw e;
                    } else {
                      continue;
                    }
                  }

                  // login
                  try {
                    let auth_type = "NONE";
                    let chap_username = "";
                    let chap_secret = "";
                    if (
                      normalizedSecrets[
                        "node-db.node.session.auth.authmethod"
                      ] == "CHAP"
                    ) {
                      // set auth_type
                      if (
                        normalizedSecrets[
                          "node-db.node.session.auth.username"
                        ] &&
                        normalizedSecrets[
                          "node-db.node.session.auth.password"
                        ] &&
                        normalizedSecrets[
                          "node-db.node.session.auth.username_in"
                        ] &&
                        normalizedSecrets[
                          "node-db.node.session.auth.password_in"
                        ]
                      ) {
                        auth_type = "MUTUAL_CHAP";
                      } else if (
                        normalizedSecrets[
                          "node-db.node.session.auth.username"
                        ] &&
                        normalizedSecrets["node-db.node.session.auth.password"]
                      ) {
                        auth_type = "ONE_WAY_CHAP";
                      }

                      // set credentials
                      if (
                        normalizedSecrets[
                          "node-db.node.session.auth.username"
                        ] &&
                        normalizedSecrets["node-db.node.session.auth.password"]
                      ) {
                        chap_username =
                          normalizedSecrets[
                            "node-db.node.session.auth.username"
                          ];

                        chap_secret =
                          normalizedSecrets[
                            "node-db.node.session.auth.password"
                          ];
                      }
                    }
                    await wutils.ConnectIscsiTarget(
                      target_address,
                      target_port,
                      iscsiConnection.iqn,
                      auth_type,
                      chap_username,
                      chap_secret,
                      multipath
                    );
                  } catch (e) {
                    let details = _.get(e, "stderr", "");
                    if (
                      !details.includes(
                        "The target has already been logged in via an iSCSI session"
                      )
                    ) {
                      driver.ctx.logger.warn(
                        `failed connection to ${JSON.stringify(
                          iscsiConnection
                        )}: ${e.stderr}`
                      );
                      if (!multipath) {
                        throw e;
                      }
                    }
                  }

                  // discover?
                  //await csiProxyClient.executeRPC("iscsi", "DiscoverTargetPortal", {
                  //  target_portal,
                  //});
                  successful_logins++;
                }

                if (iscsiConnections.length != successful_logins) {
                  driver.ctx.logger.warn(
                    `failed to login to all portals: total - ${iscsiConnections.length}, logins - ${successful_logins}`
                  );
                }

                // let things settle
                // this will help in dm scenarios
                await GeneralUtils.sleep(2000);

                // rescan
                await wutils.UpdateHostStorageCache();

                // get device
                let disks = await wutils.GetTargetDisksByIqnLun(
                  volume_context.iqn,
                  volume_context.lun
                );
                let disk;

                if (disks.length == 0) {
                  throw new GrpcError(
                    grpc.status.UNAVAILABLE,
                    `0 disks created by ${successful_logins} successful logins`
                  );
                }

                if (disks.length > 1) {
                  if (multipath) {
                    let disk_number_set = new Set();
                    disks.forEach((i_disk) => {
                      disk_number_set.add(i_disk.DiskNumber);
                    });
                    if (disk_number_set.length > 1) {
                      throw new GrpcError(
                        grpc.status.FAILED_PRECONDITION,
                        "using multipath but mpio is not properly configured (multiple disk numbers with same iqn/lun)"
                      );
                    }
                    // find first disk that is online
                    disk = disks.find((i_disk) => {
                      return i_disk.OperationalStatus == "Online";
                    });

                    if (!disk) {
                      throw new GrpcError(
                        grpc.status.FAILED_PRECONDITION,
                        "using multipath but mpio is not properly configured (failed to detect an online disk)"
                      );
                    }
                  } else {
                    throw new GrpcError(
                      grpc.status.FAILED_PRECONDITION,
                      `not using multipath but discovered ${disks.length} disks (multiple disks with same iqn/lun)`
                    );
                  }
                } else {
                  disk = disks[0];
                }

                if (multipath && !disk.Path.startsWith("\\\\?\\mpio#")) {
                  throw new GrpcError(
                    grpc.status.FAILED_PRECONDITION,
                    "using multipath but mpio is not properly configured (discover disk is not an mpio disk)"
                  );
                }

                // needs to be initialized
                await wutils.PartitionDisk(disk.DiskNumber);

                let partition = await wutils.GetLastPartitionByDiskNumber(
                  disk.DiskNumber
                );

                let volume = await wutils.GetVolumeByDiskNumberPartitionNumber(
                  disk.DiskNumber,
                  partition.PartitionNumber
                );
                if (!volume) {
                  throw new Error("failed to create/discover volume for disk");
                }

                result = await wutils.VolumeIsFormatted(volume.UniqueId);
                if (!result) {
                  // format device
                  await wutils.FormatVolume(volume.UniqueId);
                }

                result = await wutils.GetItem(win_staging_target_path);
                if (!result) {
                  fs.mkdirSync(win_staging_target_path, {
                    recursive: true,
                    mode: "755",
                  });
                  result = await wutils.GetItem(win_staging_target_path);
                }

                if (!volume.UniqueId.includes(result.Target[0])) {
                  // mount up!
                  await wutils.MountVolume(
                    volume.UniqueId,
                    win_staging_target_path
                  );
                }
                break;
              case "block":
              default:
                throw new GrpcError(
                  grpc.status.UNIMPLEMENTED,
                  `access_type ${access_type} unsupported`
                );
            }
            break;
          case "hostpath":
            // if exists already delete if folder, return if symlink
            if (await filesystem.pathExists(win_staging_target_path)) {
              // remove pre-created dir by CO
              if (!(await filesystem.isSymbolicLink(win_staging_target_path))) {
                fs.rmdirSync(win_staging_target_path);
              } else {
                // assume symlink points to the correct location
                return {};
              }
            }

            // create symlink
            fs.symlinkSync(
              filesystem.covertUnixSeparatorToWindowsSeparator(
                volume_context.path
              ),
              win_staging_target_path
            );
            return {};
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      case NODE_OS_DRIVER_CSI_PROXY:
        // sanity check node_attach_driver
        if (!["smb", "iscsi"].includes(node_attach_driver)) {
          throw new GrpcError(
            grpc.status.UNIMPLEMENTED,
            `csi-proxy does not work with node_attach_driver: ${node_attach_driver}`
          );
        }

        // sanity check fs_type
        if (fs_type && !["ntfs", "cifs"].includes(fs_type)) {
          throw new GrpcError(
            grpc.status.UNIMPLEMENTED,
            `csi-proxy does not work with fs_type: ${fs_type}`
          );
        }

        // load up the client instance
        const csiProxyClient = driver.getDefaultCsiProxyClientInstance();

        switch (node_attach_driver) {
          case "smb":
            /**
             * smb mount creates a link at this location and if the dir already exists
             * it explodes
             *
             * if path exists but is NOT symlink delete it
             */
            result = await csiProxyClient.FilesystemPathExists(
              staging_target_path
            );
            if (result) {
              result = await csiProxyClient.FilesystemIsSymlink(
                staging_target_path
              );
              if (!result) {
                await csiProxyClient.executeRPC("filesystem", "Rmdir", {
                  path: staging_target_path,
                });
              }
            }

            device = `//${volume_context.server}/${volume_context.share}`;
            const username = driver.getMountFlagValue(mount_flags, "username");
            const password = driver.getMountFlagValue(mount_flags, "password");

            if (!username || !password) {
              throw new Error("username and password required");
            }

            try {
              await csiProxyClient.executeRPC("smb", "NewSmbGlobalMapping", {
                // convert path separator for windows style path
                remote_path:
                  filesystem.covertUnixSeparatorToWindowsSeparator(device),
                local_path: staging_target_path,
                username: `${volume_context.server}\\${username}`,
                password,
              });
            } catch (e) {
              let details = _.get(e, "details", "");
              if (!details.includes("ResourceExists")) {
                throw e;
              } else {
                // path should be a symlink if already present
                result = await csiProxyClient.executeRPC(
                  "filesystem",
                  "IsSymlink",
                  { path: staging_target_path }
                );
                if (!_.get(result, "is_symlink", false)) {
                  throw e;
                }
              }
            }

            break;
          case "iscsi":
            switch (access_type) {
              case "mount":
                let portals = [];
                if (volume_context.portal) {
                  portals.push(volume_context.portal.trim());
                }

                if (volume_context.portals) {
                  volume_context.portals.split(",").forEach((portal) => {
                    portals.push(portal.trim());
                  });
                }

                // ensure full portal value
                portals = portals.map((value) => {
                  if (!value.includes(":")) {
                    value += ":3260";
                  }

                  return value.trim();
                });

                // ensure unique entries only
                portals = [...new Set(portals)];

                // stores actual device paths after iscsi login
                let iscsiDevices = [];

                // stores configuration of targets/iqn/luns to connect to
                let iscsiConnections = [];
                for (let portal of portals) {
                  iscsiConnections.push({
                    portal,
                    iqn: volume_context.iqn,
                    lun: volume_context.lun,
                  });
                }

                // no multipath support yet
                // https://github.com/kubernetes-csi/csi-proxy/pull/99
                for (let iscsiConnection of iscsiConnections) {
                  // add target portal
                  let parts = iscsiConnection.portal.split(":");
                  let target_address = parts[0];
                  let target_port = parts[1] || "3260";
                  let target_portal = {
                    target_address,
                    target_port,
                  };
                  // this is idempotent
                  await csiProxyClient.executeRPC("iscsi", "AddTargetPortal", {
                    target_portal,
                  });

                  // login
                  try {
                    let auth_type = "NONE";
                    let chap_username = "";
                    let chap_secret = "";
                    if (
                      normalizedSecrets[
                        "node-db.node.session.auth.authmethod"
                      ] == "CHAP"
                    ) {
                      // set auth_type
                      if (
                        normalizedSecrets[
                          "node-db.node.session.auth.username"
                        ] &&
                        normalizedSecrets[
                          "node-db.node.session.auth.password"
                        ] &&
                        normalizedSecrets[
                          "node-db.node.session.auth.username_in"
                        ] &&
                        normalizedSecrets[
                          "node-db.node.session.auth.password_in"
                        ]
                      ) {
                        auth_type = "MUTUAL_CHAP";
                      } else if (
                        normalizedSecrets[
                          "node-db.node.session.auth.username"
                        ] &&
                        normalizedSecrets["node-db.node.session.auth.password"]
                      ) {
                        auth_type = "ONE_WAY_CHAP";
                      }

                      // set credentials
                      if (
                        normalizedSecrets[
                          "node-db.node.session.auth.username"
                        ] &&
                        normalizedSecrets["node-db.node.session.auth.password"]
                      ) {
                        chap_username =
                          normalizedSecrets[
                            "node-db.node.session.auth.username"
                          ];

                        chap_secret =
                          normalizedSecrets[
                            "node-db.node.session.auth.password"
                          ];
                      }
                    }
                    await csiProxyClient.executeRPC("iscsi", "ConnectTarget", {
                      target_portal,
                      iqn: iscsiConnection.iqn,
                      /**
                       * NONE
                       * ONE_WAY_CHAP
                       * MUTUAL_CHAP
                       */
                      auth_type,
                      chap_username,
                      chap_secret,
                    });
                  } catch (e) {
                    let details = _.get(e, "details", "");
                    if (
                      !details.includes(
                        "The target has already been logged in via an iSCSI session"
                      )
                    ) {
                      throw e;
                    }
                  }

                  // discover?
                  //await csiProxyClient.executeRPC("iscsi", "DiscoverTargetPortal", {
                  //  target_portal,
                  //});

                  // rescan
                  await csiProxyClient.executeRPC("disk", "Rescan");

                  // get device
                  result = await csiProxyClient.executeRPC(
                    "iscsi",
                    "GetTargetDisks",
                    {
                      target_portal,
                      iqn: iscsiConnection.iqn,
                    }
                  );

                  // TODO: this is a gross assumption since we currently only allow 1 lun per target
                  // iterate this response and find disk
                  //result = await csiProxyClient.executeRPC("disk", "ListDiskLocations");
                  let diskIds = _.get(result, "diskIDs", []);
                  if (diskIds.length != 1) {
                    throw new Error(
                      `${diskIds.length} disks on the target, no way to know which is the relevant disk`
                    );
                  }
                  let disk_number = diskIds[0];

                  result = await csiProxyClient.executeRPC(
                    "volume",
                    "ListVolumesOnDisk",
                    { disk_number }
                  );

                  let node_volume_id;
                  node_volume_id =
                    await csiProxyClient.getVolumeIdFromDiskNumber(disk_number);

                  if (!node_volume_id) {
                    // this is technically idempotent call so should not hurt anything if already initialized
                    await csiProxyClient.executeRPC("disk", "PartitionDisk", {
                      disk_number,
                    });
                    node_volume_id =
                      await csiProxyClient.getVolumeIdFromDiskNumber(
                        disk_number
                      );
                  }

                  if (!node_volume_id) {
                    throw new Error(
                      "failed to create/discover volume for disk"
                    );
                  }
                  result = await csiProxyClient.executeRPC(
                    "volume",
                    "IsVolumeFormatted",
                    { volume_id: node_volume_id }
                  );

                  // format device
                  if (!result.formatted) {
                    await csiProxyClient.executeRPC("volume", "FormatVolume", {
                      volume_id: node_volume_id,
                    });
                  }

                  // ensure staging path present
                  result = await csiProxyClient.FilesystemPathExists(
                    staging_target_path
                  );
                  if (!result) {
                    await csiProxyClient.executeRPC("filesystem", "Mkdir", {
                      path: staging_target_path,
                    });
                  }

                  // mount up!
                  try {
                    result = await csiProxyClient.executeRPC(
                      "volume",
                      "MountVolume",
                      {
                        volume_id: node_volume_id,
                        target_path: staging_target_path,
                      }
                    );
                  } catch (e) {
                    // assume for now that if something is mounted in the location it the desired volume
                    let details = _.get(e, "details", "");
                    if (
                      !details.includes(
                        "The requested access path is already in use"
                      )
                    ) {
                      throw e;
                    }
                  }

                  // let things settle
                  // this will help in dm scenarios
                  await GeneralUtils.sleep(2000);

                  // windows does not support multipath currently
                  // break if we make it this far
                  break;
                }

                break;
              case "block":
              default:
                throw new GrpcError(
                  grpc.status.UNIMPLEMENTED,
                  `access_type ${access_type} unsupported`
                );
            }
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `unkown NODE OS DRIVER: ${driver.__getNodeOsDriver()}`
        );
    }

    return {};
  }

  /**
   * NOTE: only gets called when the last pod on the node using the volume is removed
   *
   * 1. unmount fs
   * 2. logout of iscsi if neccessary
   *
   * @param {*} call
   */
  async NodeUnstageVolume(call) {
    const driver = this;
    const mount = driver.getDefaultMountInstance();
    const filesystem = driver.getDefaultFilesystemInstance();
    const iscsi = driver.getDefaultISCSIInstance();
    const nvmeof = driver.getDefaultNVMEoFInstance();
    let result;
    let is_block = false;
    let is_device_mapper = false;
    let block_device_info;
    let access_type = "mount";

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const staging_target_path = call.request.staging_target_path;
    if (!staging_target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `missing staging_target_path`
      );
    }
    const block_path = staging_target_path + "/block_device";
    let normalized_staging_path = staging_target_path;
    const umount_args = [];
    const umount_force_extra_args = ["--force", "--lazy"];

    //result = await mount.pathIsMounted(block_path);
    //result = await mount.pathIsMounted(staging_target_path)

    // TODO: use the x-* mount options to detect if we should delete target

    switch (driver.__getNodeOsDriver()) {
      case NODE_OS_DRIVER_POSIX:
        try {
          result = await mount.pathIsMounted(block_path);
        } catch (err) {
          /**
           * on stalled fs such as nfs, even findmnt will return immediately for the base mount point
           * so in the case of timeout here (base mount point and then a file/folder beneath it) we almost certainly are not a block device
           * AND the fs is probably stalled
           */
          if (err.timeout) {
            driver.ctx.logger.warn(
              `detected stale mount, attempting to force unmount: ${normalized_staging_path}`
            );
            await mount.umount(
              normalized_staging_path,
              umount_args.concat(umount_force_extra_args)
            );
            result = false; // assume we are *NOT* a block device at this point
          } else {
            throw err;
          }
        }

        if (result) {
          is_block = true;
          access_type = "block";
          block_device_info = await filesystem.getBlockDevice(block_path);
          normalized_staging_path = block_path;
        } else {
          result = await mount.pathIsMounted(staging_target_path);
          if (result) {
            let device = await mount.getMountPointDevice(staging_target_path);
            result = await filesystem.isBlockDevice(device);
            if (result) {
              is_block = true;
              block_device_info = await filesystem.getBlockDevice(device);
            }
          }
        }

        result = await mount.pathIsMounted(normalized_staging_path);
        if (result) {
          try {
            result = await GeneralUtils.retry(
              10,
              0,
              async () => {
                return await mount.umount(normalized_staging_path, umount_args);
              },
              {
                minExecutionTime: 1000,
                retryCondition: (err) => {
                  if (_.get(err, "stderr", "").includes("busy")) {
                    return true;
                  }
                },
              }
            );
          } catch (err) {
            if (err.timeout) {
              driver.ctx.logger.warn(
                `hit timeout waiting to unmount path: ${normalized_staging_path}`
              );
              result = await mount.getMountDetails(normalized_staging_path);
              switch (result.fstype) {
                case "nfs":
                case "nfs4":
                  driver.ctx.logger.warn(
                    `detected stale nfs filesystem, attempting to force unmount: ${normalized_staging_path}`
                  );
                  result = await mount.umount(
                    normalized_staging_path,
                    umount_args.concat(umount_force_extra_args)
                  );
                  break;
                default:
                  throw err;
              }
            } else {
              throw err;
            }
          }
        }

        if (is_block) {
          let breakdeviceloop = false;
          let realBlockDeviceInfos = [];
          // detect if is a multipath device
          is_device_mapper = await filesystem.isDeviceMapperDevice(
            block_device_info.path
          );

          if (is_device_mapper) {
            let realBlockDevices = await filesystem.getDeviceMapperDeviceSlaves(
              block_device_info.path
            );
            for (const realBlockDevice of realBlockDevices) {
              realBlockDeviceInfos.push(
                await filesystem.getBlockDevice(realBlockDevice)
              );
            }
          } else {
            realBlockDeviceInfos = [block_device_info];
          }

          // TODO: this could be made async to detach all simultaneously
          for (const block_device_info_i of realBlockDeviceInfos) {
            if (breakdeviceloop) {
              break;
            }
            switch (block_device_info_i.tran) {
              case "iscsi":
                {
                  if (
                    await filesystem.deviceIsIscsi(block_device_info_i.path)
                  ) {
                    let parent_block_device =
                      await filesystem.getBlockDeviceParent(
                        block_device_info_i.path
                      );

                    // figure out which iscsi session this belongs to and logout
                    // scan /dev/disk/by-path/ip-*?
                    // device = `/dev/disk/by-path/ip-${volume_context.portal}-iscsi-${volume_context.iqn}-lun-${volume_context.lun}`;
                    // parse output from `iscsiadm -m session -P 3`
                    let sessions = await iscsi.iscsiadm.getSessionsDetails();
                    for (let i = 0; i < sessions.length; i++) {
                      let session = sessions[i];
                      let is_attached_to_session = false;

                      if (
                        session.attached_scsi_devices &&
                        session.attached_scsi_devices.host &&
                        session.attached_scsi_devices.host.devices
                      ) {
                        is_attached_to_session =
                          session.attached_scsi_devices.host.devices.some(
                            (device) => {
                              if (
                                device.attached_scsi_disk ==
                                parent_block_device.name
                              ) {
                                return true;
                              }
                              return false;
                            }
                          );
                      }

                      if (is_attached_to_session) {
                        let timer_start;
                        let timer_max;

                        timer_start = Math.round(new Date().getTime() / 1000);
                        timer_max = 30;
                        let loggedOut = false;
                        while (!loggedOut) {
                          try {
                            await iscsi.iscsiadm.logout(session.target, [
                              session.persistent_portal,
                            ]);
                            loggedOut = true;
                          } catch (err) {
                            await GeneralUtils.sleep(2000);
                            let current_time = Math.round(
                              new Date().getTime() / 1000
                            );
                            if (current_time - timer_start > timer_max) {
                              // not throwing error for now as future invocations would not enter code path anyhow
                              loggedOut = true;
                              //throw new GrpcError(
                              //  grpc.status.UNKNOWN,
                              //  `hit timeout trying to logout of iscsi target: ${session.persistent_portal}`
                              //);
                            }
                          }
                        }

                        timer_start = Math.round(new Date().getTime() / 1000);
                        timer_max = 30;
                        let deletedEntry = false;
                        while (!deletedEntry) {
                          try {
                            await iscsi.iscsiadm.deleteNodeDBEntry(
                              session.target,
                              session.persistent_portal
                            );
                            deletedEntry = true;
                          } catch (err) {
                            await GeneralUtils.sleep(2000);
                            let current_time = Math.round(
                              new Date().getTime() / 1000
                            );
                            if (current_time - timer_start > timer_max) {
                              // not throwing error for now as future invocations would not enter code path anyhow
                              deletedEntry = true;
                              //throw new GrpcError(
                              //  grpc.status.UNKNOWN,
                              //  `hit timeout trying to delete iscsi node DB entry: ${session.target}, ${session.persistent_portal}`
                              //);
                            }
                          }
                        }
                      }
                    }
                  }
                }
                break;
              case "nvme":
                {
                  if (
                    await filesystem.deviceIsNVMEoF(block_device_info_i.path)
                  ) {
                    let nqn = await nvmeof.nqnByNamespaceDeviceName(
                      block_device_info_i.name
                    );
                    if (nqn) {
                      await nvmeof.disconnectByNQN(nqn);
                      /**
                       * the above disconnects *all* devices with the nqn so we
                       * do NOT want to keep iterating all the 'real' devices
                       * in the case of DM multipath
                       */
                      breakdeviceloop = true;
                    }
                  }
                }
                break;
            }
          }
        }

        if (access_type == "block") {
          // remove touched file
          result = await filesystem.pathExists(block_path);
          if (result) {
            result = await GeneralUtils.retry(
              30,
              0,
              async () => {
                return await filesystem.rm(block_path);
              },
              {
                minExecutionTime: 1000,
                retryCondition: (err) => {
                  if (_.get(err, "stderr", "").includes("busy")) {
                    return true;
                  }
                },
              }
            );
          }
        }

        result = await filesystem.pathExists(staging_target_path);
        if (result) {
          result = await GeneralUtils.retry(
            30,
            0,
            async () => {
              return await filesystem.rmdir(staging_target_path);
            },
            {
              minExecutionTime: 1000,
              retryCondition: (err) => {
                if (_.get(err, "stderr", "").includes("busy")) {
                  return true;
                }
              },
            }
          );
        }
        break;
      case NODE_OS_DRIVER_WINDOWS: {
        const WindowsUtils = require("../utils/windows").Windows;
        const wutils = new WindowsUtils();

        let win_normalized_staging_path =
          filesystem.covertUnixSeparatorToWindowsSeparator(
            normalized_staging_path
          );

        async function removePath(p) {
          // remove staging path
          try {
            fs.rmdirSync(p);
          } catch (e) {
            if (e.code !== "ENOENT") {
              throw e;
            }
          }
        }

        let node_attach_driver;
        let win_volume_id;

        result = await wutils.GetItem(win_normalized_staging_path);
        if (result) {
          let target = _.get(result, "Target.[0]", "");
          if (target.startsWith("UNC")) {
            node_attach_driver = "smb";
          }
          if (target.startsWith("Volume")) {
            win_volume_id = `\\\\?\\${target}`;
            if (await wutils.VolumeIsIscsi(win_volume_id)) {
              node_attach_driver = "iscsi";
            }
          }

          if (!node_attach_driver) {
            // nothing we care about
            node_attach_driver = "bypass";
          }

          switch (node_attach_driver) {
            case "smb":
              // remove symlink *before* disconnecting
              await removePath(win_normalized_staging_path);
              let parts = target.split("\\");
              // only remove global mapping if we certain there may not be other
              // consumers of the mapping/share (ie: smb-client scenarios, etc)
              if (!parts[3]) {
                await wutils.RemoveSmbGlobalMapping(
                  `\\\\${parts[1]}\\${parts[2]}`
                );
              }
              break;
            case "iscsi":
              // write volume cache
              await wutils.WriteVolumeCache(win_volume_id);

              // unmount volume
              await wutils.UnmountVolume(
                win_volume_id,
                win_normalized_staging_path
              );

              // find sessions associated with volume/disks
              let sessions = await wutils.GetIscsiSessionsByVolumeId(
                win_volume_id
              );

              // logout of sessions
              for (let session of sessions) {
                await wutils.DisconnectIscsiTargetByNodeAddress(
                  session.TargetNodeAddress
                );
              }

              // delete target/target portal/etc
              // do NOT do this now as removing the portal will remove all targets associated with it
              break;
            case "hostpath":
              // allow below code to remove symlink
              break;
            case "bypass":
              break;
            default:
              throw new GrpcError(
                grpc.status.INVALID_ARGUMENT,
                `unknown/unsupported node_attach_driver: ${node_attach_driver}`
              );
          }
        }

        // remove staging path
        await removePath(win_normalized_staging_path);
        break;
      }
      case NODE_OS_DRIVER_CSI_PROXY:
        // load up the client instance
        const csiProxyClient = driver.getDefaultCsiProxyClientInstance();
        // for testing purposes
        const volume_context = await driver.getDerivedVolumeContext(call);
        if (!volume_context) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `unable to retrieve volume_context for volume: ${volume_id}`
          );
        }

        const node_attach_driver = volume_context.node_attach_driver;

        async function removePath(p) {
          // remove staging path
          try {
            await csiProxyClient.executeRPC("filesystem", "Rmdir", {
              path: p,
              // remove all contents under the directory
              //force: false,
            });
          } catch (e) {
            let details = _.get(e, "details", "");
            if (
              !details.includes("The system cannot find the file specified")
            ) {
              throw e;
            }
          }
        }

        switch (node_attach_driver) {
          case "smb":
            try {
              await csiProxyClient.executeRPC("smb", "RemoveSmbGlobalMapping", {
                remote_path: `\\\\${volume_context.server}\\${volume_context.share}`,
              });
            } catch (e) {
              let details = _.get(e, "details", "");
              if (!details.includes("No MSFT_SmbGlobalMapping objects found")) {
                throw e;
              }
            }

            break;
          case "iscsi":
            let target_portal = {
              target_address: volume_context.portal.split(":")[0],
              target_port: volume_context.portal.split(":")[1] || 3260,
            };

            let iqn = volume_context.iqn;
            let node_volume_id;

            // ok to be null/undefined
            node_volume_id = await csiProxyClient.getVolumeIdFromIscsiTarget(
              target_portal,
              iqn
            );

            if (node_volume_id) {
              // write volume cache
              await csiProxyClient.executeRPC("volume", "WriteVolumeCache", {
                volume_id: node_volume_id,
              });

              // umount first
              try {
                await csiProxyClient.executeRPC("volume", "UnmountVolume", {
                  volume_id: node_volume_id,
                  target_path: staging_target_path,
                });
              } catch (e) {
                let details = _.get(e, "details", "");
                if (!details.includes("The access path is not valid")) {
                  throw e;
                }
              }
            }

            try {
              await csiProxyClient.executeRPC("iscsi", "DisconnectTarget", {
                target_portal,
                iqn,
              });
            } catch (e) {
              let details = _.get(e, "details", "");
              if (!details.includes("ObjectNotFound")) {
                throw e;
              }
            }

            // do NOT remove target portal etc, windows handles this quite differently than
            // linux and removing the portal would remove all the targets/etc
            /*
            try {
              await csiProxyClient.executeRPC("iscsi", "RemoveTargetPortal", {
                target_portal,
              });
            } catch (e) {
              let details = _.get(e, "details", "");
              if (!details.includes("ObjectNotFound")) {
                throw e;
              }
            }
            */

            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }

        // remove staging path
        await removePath(normalized_staging_path);
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `unkown NODE OS DRIVER: ${driver.__getNodeOsDriver()}`
        );
    }

    return {};
  }

  async NodePublishVolume(call) {
    const driver = this;
    const mount = driver.getDefaultMountInstance();
    const filesystem = driver.getDefaultFilesystemInstance();
    let result;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const staging_target_path = call.request.staging_target_path || "";
    const target_path = call.request.target_path;
    if (!target_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing target_path`);
    }
    const capability = call.request.volume_capability;
    if (!capability || Object.keys(capability).length === 0) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing capability`);
    }
    const access_type = capability.access_type || "mount";
    let mount_flags;
    let volume_mount_group;
    const readonly = call.request.readonly;
    const volume_context = call.request.volume_context;
    const bind_mount_flags = [];
    const node_attach_driver = volume_context.node_attach_driver;

    if (access_type == "mount") {
      mount_flags = capability.mount.mount_flags || [];
      bind_mount_flags.push(...mount_flags);

      if (
        semver.satisfies(driver.ctx.csiVersion, ">=1.5.0") &&
        driver.options.service.node.capabilities.rpc.includes(
          "VOLUME_MOUNT_GROUP"
        )
      ) {
        volume_mount_group = capability.mount.volume_mount_group; // in k8s this is derrived from the fsgroup in the pod security context
      }
    }

    bind_mount_flags.push("defaults");

    // https://github.com/karelzak/util-linux/issues/1429
    //bind_mount_flags.push("x-democratic-csi.managed");
    //bind_mount_flags.push("x-democratic-csi.published");

    if (readonly) bind_mount_flags.push("ro");
    // , "x-democratic-csi.ro"

    switch (driver.__getNodeOsDriver()) {
      case NODE_OS_DRIVER_POSIX:
        switch (node_attach_driver) {
          case "nfs":
          case "smb":
          case "lustre":
          case "oneclient":
          case "hostpath":
          case "iscsi":
          case "nvmeof":
          case "zfs-local":
            // ensure appropriate directories/files
            switch (access_type) {
              case "mount":
                // ensure directory exists
                result = await filesystem.pathExists(target_path);
                if (!result) {
                  await filesystem.mkdir(target_path, ["-p", "-m", "0750"]);
                }

                break;
              case "block":
                // ensure target_path directory exists as target path should be a file
                let target_dir = await filesystem.dirname(target_path);
                result = await filesystem.pathExists(target_dir);
                if (!result) {
                  await filesystem.mkdir(target_dir, ["-p", "-m", "0750"]);
                }

                // ensure target file exists
                result = await filesystem.pathExists(target_path);
                if (!result) {
                  await filesystem.touch(target_path);
                }
                break;
              default:
                throw new GrpcError(
                  grpc.status.INVALID_ARGUMENT,
                  `unsupported/unknown access_type ${access_type}`
                );
            }

            // ensure bind mount
            if (staging_target_path) {
              let normalized_staging_device;
              let normalized_staging_path;

              if (access_type == "block") {
                normalized_staging_path = staging_target_path + "/block_device";
              } else {
                normalized_staging_path = staging_target_path;
              }

              // sanity check to ensure the staged path is actually mounted
              result = await mount.pathIsMounted(normalized_staging_path);
              if (!result) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  `staging path is not mounted: ${normalized_staging_path}`
                );
              }

              result = await mount.pathIsMounted(target_path);
              // if not mounted, mount
              if (!result) {
                await mount.bindMount(normalized_staging_path, target_path, [
                  "-o",
                  bind_mount_flags.join(","),
                ]);
              } else {
                // if is mounted, ensure proper source
                if (access_type == "block") {
                  normalized_staging_device = "dev"; // special syntax for single file bind mounts
                } else {
                  normalized_staging_device = await mount.getMountPointDevice(
                    staging_target_path
                  );
                }
                result = await mount.deviceIsMountedAtPath(
                  normalized_staging_device,
                  target_path
                );
                if (!result) {
                  throw new GrpcError(
                    grpc.status.FAILED_PRECONDITION,
                    `it appears ${normalized_staging_device} is already mounted at ${target_path}, should be ${normalized_staging_path}`
                  );
                }
              }

              return {};
            }

            // unsupported filesystem
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `only staged configurations are valid`
            );
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      case NODE_OS_DRIVER_WINDOWS:
        const WindowsUtils = require("../utils/windows").Windows;
        const wutils = new WindowsUtils();

        switch (node_attach_driver) {
          //case "nfs":
          case "smb":
          //case "lustre":
          //case "oneclient":
          case "hostpath":
          case "iscsi":
            //case "zfs-local":
            // ensure appropriate directories/files
            switch (access_type) {
              case "mount":
                break;
              case "block":
              default:
                throw new GrpcError(
                  grpc.status.INVALID_ARGUMENT,
                  `unsupported/unknown access_type ${access_type}`
                );
            }

            // ensure bind mount
            if (staging_target_path) {
              let normalized_staging_path;

              if (access_type == "block") {
                normalized_staging_path = staging_target_path + "/block_device";
              } else {
                normalized_staging_path = staging_target_path;
              }

              normalized_staging_path =
                filesystem.covertUnixSeparatorToWindowsSeparator(
                  normalized_staging_path
                );

              // source path
              result = await filesystem.pathExists(normalized_staging_path);
              if (!result) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  `staging path is not mounted: ${normalized_staging_path}`
                );
              }

              // target path
              result = await filesystem.pathExists(target_path);
              // already published
              if (result) {
                if (!(await filesystem.isSymbolicLink(target_path))) {
                  throw new GrpcError(
                    grpc.status.FAILED_PRECONDITION,
                    `target path exists but is not a symlink as it should be: ${target_path}`
                  );
                }
                return {};
              }

              // create symlink
              fs.symlinkSync(normalized_staging_path, target_path);
              return {};
            }

            // unsupported filesystem
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `only staged configurations are valid`
            );
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      case NODE_OS_DRIVER_CSI_PROXY:
        switch (node_attach_driver) {
          //case "nfs":
          case "smb":
          //case "lustre":
          //case "oneclient":
          //case "hostpath":
          case "iscsi":
            //case "zfs-local":
            // ensure appropriate directories/files
            switch (access_type) {
              case "mount":
                break;
              case "block":
              default:
                throw new GrpcError(
                  grpc.status.INVALID_ARGUMENT,
                  `unsupported/unknown access_type ${access_type}`
                );
            }

            // ensure bind mount
            if (staging_target_path) {
              const csiProxyClient = driver.getDefaultCsiProxyClientInstance();

              let normalized_staging_path;

              if (access_type == "block") {
                normalized_staging_path = staging_target_path + "/block_device";
              } else {
                normalized_staging_path = staging_target_path;
              }

              // source path
              result = await csiProxyClient.FilesystemPathExists(
                normalized_staging_path
              );
              if (!result) {
                throw new GrpcError(
                  grpc.status.FAILED_PRECONDITION,
                  `staging path is not mounted: ${normalized_staging_path}`
                );
              }

              // target path
              result = await csiProxyClient.FilesystemPathExists(target_path);
              // already published
              if (result) {
                result = await csiProxyClient.FilesystemIsSymlink(target_path);
                if (!result) {
                  throw new GrpcError(
                    grpc.status.FAILED_PRECONDITION,
                    `target path exists but is not a symlink as it should be: ${target_path}`
                  );
                }
                return {};
              }

              // create symlink
              await csiProxyClient.executeRPC("filesystem", "CreateSymlink", {
                source_path: normalized_staging_path,
                target_path,
              });

              return {};
            }

            // unsupported filesystem
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `only staged configurations are valid`
            );
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `unkown NODE OS DRIVER: ${driver.__getNodeOsDriver()}`
        );
    }
  }

  async NodeUnpublishVolume(call) {
    const driver = this;
    const mount = driver.getDefaultMountInstance();
    const filesystem = driver.getDefaultFilesystemInstance();
    let result;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const target_path = call.request.target_path;
    if (!target_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing target_path`);
    }
    const umount_args = [];
    const umount_force_extra_args = ["--force", "--lazy"];

    switch (driver.__getNodeOsDriver()) {
      case NODE_OS_DRIVER_POSIX:
        try {
          result = await mount.pathIsMounted(target_path);
        } catch (err) {
          // running findmnt on non-existant paths return immediately
          // the only time this should timeout is on a stale fs
          // so if timeout is hit we should be near certain it is indeed mounted
          if (err.timeout) {
            driver.ctx.logger.warn(
              `detected stale mount, attempting to force unmount: ${target_path}`
            );
            await mount.umount(
              target_path,
              umount_args.concat(umount_force_extra_args)
            );
            result = false; // assume we have fully unmounted
          } else {
            throw err;
          }
        }

        if (result) {
          try {
            result = await GeneralUtils.retry(
              10,
              0,
              async () => {
                return await mount.umount(target_path, umount_args);
              },
              {
                minExecutionTime: 1000,
                retryCondition: (err) => {
                  if (_.get(err, "stderr", "").includes("busy")) {
                    return true;
                  }
                },
              }
            );
          } catch (err) {
            if (err.timeout) {
              driver.ctx.logger.warn(
                `hit timeout waiting to unmount path: ${target_path}`
              );
              // bind mounts do show the 'real' fs details
              result = await mount.getMountDetails(target_path);
              switch (result.fstype) {
                case "nfs":
                case "nfs4":
                  driver.ctx.logger.warn(
                    `detected stale nfs filesystem, attempting to force unmount: ${target_path}`
                  );
                  result = await mount.umount(
                    target_path,
                    umount_args.concat(umount_force_extra_args)
                  );
                  break;
                default:
                  throw err;
              }
            } else {
              throw err;
            }
          }
        }

        result = await filesystem.pathExists(target_path);
        if (result) {
          if (fs.lstatSync(target_path).isDirectory()) {
            result = await GeneralUtils.retry(
              30,
              0,
              async () => {
                return await filesystem.rmdir(target_path);
              },
              {
                minExecutionTime: 1000,
                retryCondition: (err) => {
                  if (_.get(err, "stderr", "").includes("busy")) {
                    return true;
                  }
                },
              }
            );
          } else {
            result = await GeneralUtils.retry(
              30,
              0,
              async () => {
                return await filesystem.rm([target_path]);
              },
              { minExecutionTime: 1000 }
            );
          }
        }

        break;
      case NODE_OS_DRIVER_WINDOWS:
        const WindowsUtils = require("../utils/windows").Windows;
        const wutils = new WindowsUtils();
        let win_target_path =
          filesystem.covertUnixSeparatorToWindowsSeparator(target_path);

        result = await filesystem.pathExists(win_target_path);
        if (!result) {
          return {};
        }

        if (!(await filesystem.isSymbolicLink(win_target_path))) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            `target path is not a symlink ${win_target_path}`
          );
        }

        fs.rmdirSync(win_target_path);
        break;
      case NODE_OS_DRIVER_CSI_PROXY:
        const csiProxyClient = driver.getDefaultCsiProxyClientInstance();

        result = await csiProxyClient.FilesystemPathExists(target_path);
        if (!result) {
          return {};
        }

        result = await csiProxyClient.executeRPC("filesystem", "IsSymlink", {
          path: target_path,
        });

        if (!result.is_symlink) {
          throw new GrpcError(
            grpc.status.FAILED_PRECONDITION,
            `target path is not a symlink ${target_path}`
          );
        }

        await csiProxyClient.executeRPC("filesystem", "Rmdir", {
          path: target_path,
        });

        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `unkown NODE OS DRIVER: ${driver.__getNodeOsDriver()}`
        );
    }

    return {};
  }

  async NodeGetVolumeStats(call) {
    const driver = this;
    const mount = driver.getDefaultMountInstance();
    const filesystem = driver.getDefaultFilesystemInstance();
    let result;
    let device_path;
    let access_type;
    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const volume_path = call.request.volume_path;
    const block_path = volume_path + "/block_device";

    if (!volume_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_path`);
    }

    let res = {};

    //VOLUME_CONDITION
    if (
      semver.satisfies(driver.ctx.csiVersion, ">=1.3.0") &&
      driver.options.service.node.capabilities.rpc.includes("VOLUME_CONDITION")
    ) {
      // TODO: let drivers fill ths in
      let abnormal = false;
      let message = "OK";
      res.volume_condition = { abnormal, message };
    }

    switch (driver.__getNodeOsDriver()) {
      case NODE_OS_DRIVER_POSIX:
        if (
          (await mount.isBindMountedBlockDevice(volume_path)) ||
          (await mount.isBindMountedBlockDevice(block_path))
        ) {
          device_path = block_path;
          access_type = "block";
        } else {
          device_path = volume_path;
          access_type = "mount";
        }

        switch (access_type) {
          case "mount":
            if (!(await mount.pathIsMounted(device_path))) {
              throw new GrpcError(
                grpc.status.NOT_FOUND,
                `nothing mounted at path: ${device_path}`
              );
            }
            result = await mount.getMountDetails(device_path, [
              "avail",
              "size",
              "used",
            ]);

            res.usage = [
              {
                available: result.avail,
                total: result.size,
                used: result.used,
                unit: "BYTES",
              },
            ];
            try {
              result = await filesystem.getInodeInfo(device_path);
              // not all filesystems use inodes, only utilize if total > 0
              if (result && result.inodes_total > 0) {
                res.usage.push({
                  available: result.inodes_free,
                  total: result.inodes_total,
                  used: result.inodes_used,
                  unit: "INODES",
                });
              }
            } catch (err) {
              driver.ctx.logger.debug("failed to retrieve inode info", err);
            }
            break;
          case "block":
            if (!(await filesystem.pathExists(device_path))) {
              throw new GrpcError(
                grpc.status.NOT_FOUND,
                `nothing mounted at path: ${device_path}`
              );
            }
            result = await filesystem.getBlockDevice(device_path);

            res.usage = [
              {
                total: result.size,
                unit: "BYTES",
              },
            ];
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unsupported/unknown access_type ${access_type}`
            );
        }

        break;
      case NODE_OS_DRIVER_WINDOWS: {
        const WindowsUtils = require("../utils/windows").Windows;
        const wutils = new WindowsUtils();
        let win_volume_path =
          filesystem.covertUnixSeparatorToWindowsSeparator(volume_path);
        // ensure path is mounted
        result = await filesystem.pathExists(win_volume_path);
        if (!result) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `volume_path ${win_volume_path} is not currently mounted`
          );
        }

        let node_attach_driver;

        let target = (await wutils.GetRealTarget(win_volume_path)) || "";
        if (target.startsWith("\\\\")) {
          node_attach_driver = "smb";
        }
        if (target.startsWith("\\\\?\\Volume")) {
          if (await wutils.VolumeIsIscsi(target)) {
            node_attach_driver = "iscsi";
          }
        }

        if (!node_attach_driver) {
          // nothing we care about
          node_attach_driver = "bypass";
        }

        switch (node_attach_driver) {
          case "smb":
            res.usage = [{ total: 0, unit: "BYTES" }];
            break;
          case "iscsi":
            let node_volume = await wutils.GetVolumeByVolumeId(target);
            res.usage = [
              {
                available: node_volume.SizeRemaining,
                total: node_volume.Size,
                used: node_volume.Size - node_volume.SizeRemaining,
                unit: "BYTES",
              },
            ];
            break;
          case "bypass":
            res.usage = [{ total: 0, unit: "BYTES" }];
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      }
      case NODE_OS_DRIVER_CSI_PROXY:
        const csiProxyClient = driver.getDefaultCsiProxyClientInstance();
        const volume_context = await driver.getDerivedVolumeContext(call);
        if (!volume_context) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `unable to retrieve volume_context for volume: ${volume_id}`
          );
        }

        const node_attach_driver = volume_context.node_attach_driver;

        // ensure path is mounted
        result = await csiProxyClient.FilesystemPathExists(volume_path);
        if (!result) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `volume_path ${volume_path} is not currently mounted`
          );
        }

        switch (node_attach_driver) {
          case "smb":
            res.usage = [{ total: 0, unit: "BYTES" }];
            break;
          case "iscsi":
            let node_volume_id =
              await csiProxyClient.getVolumeIdFromIscsiTarget(
                volume_context.portal,
                volume_context.iqn
              );
            result = await csiProxyClient.executeRPC(
              "volume",
              "GetVolumeStats",
              {
                volume_id: node_volume_id,
              }
            );
            res.usage = [
              {
                available: result.total_bytes - result.used_bytes,
                total: result.total_bytes,
                used: result.used_bytes,
                unit: "BYTES",
              },
            ];
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `unkown NODE OS DRIVER: ${driver.__getNodeOsDriver()}`
        );
    }

    return res;
  }

  /**
   * https://kubernetes-csi.github.io/docs/volume-expansion.html
   * allowVolumeExpansion: true
   * --feature-gates=ExpandCSIVolumes=true
   * --feature-gates=ExpandInUsePersistentVolumes=true
   *
   * @param {*} call
   */
  async NodeExpandVolume(call) {
    const driver = this;
    const mount = driver.getDefaultMountInstance();
    const filesystem = driver.getDefaultFilesystemInstance();
    const nvmeof = driver.getDefaultNVMEoFInstance();

    let device;
    let fs_info;
    let device_path;
    let access_type;
    let is_block = false;
    let is_formatted;
    let fs_type;
    let is_device_mapper = false;
    let result;

    const volume_id = call.request.volume_id;
    if (!volume_id) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_id`);
    }
    const volume_path = call.request.volume_path;
    if (!volume_path) {
      throw new GrpcError(grpc.status.INVALID_ARGUMENT, `missing volume_path`);
    }
    const block_path = volume_path + "/block_device";
    const capacity_range = call.request.capacity_range;
    const volume_capability = call.request.volume_capability;

    switch (driver.__getNodeOsDriver()) {
      case NODE_OS_DRIVER_POSIX:
        if (
          (await mount.isBindMountedBlockDevice(volume_path)) ||
          (await mount.isBindMountedBlockDevice(block_path))
        ) {
          access_type = "block";
          device_path = block_path;
        } else {
          access_type = "mount";
          device_path = volume_path;
        }

        try {
          device = await mount.getMountPointDevice(device_path);
          is_formatted = await filesystem.deviceIsFormatted(device);
          is_block = await filesystem.isBlockDevice(device);
        } catch (err) {
          if (err.code == 1) {
            throw new GrpcError(
              grpc.status.NOT_FOUND,
              `volume_path ${volume_path} is not currently mounted`
            );
          }
        }

        if (is_block) {
          let rescan_devices = [];
          // detect if is a multipath device
          is_device_mapper = await filesystem.isDeviceMapperDevice(device);
          if (is_device_mapper) {
            // NOTE: want to make sure we scan the dm device *after* all the underlying slaves
            rescan_devices = await filesystem.getDeviceMapperDeviceSlaves(
              device
            );
          }

          rescan_devices.push(device);

          for (let sdevice of rescan_devices) {
            let is_nvmeof = await filesystem.deviceIsNVMEoF(sdevice);
            if (is_nvmeof) {
              let controllers =
                await nvmeof.getControllersByNamespaceDeviceName(sdevice);
              for (let controller of controllers) {
                await nvmeof.rescanNamespace(`/dev/${controller.Controller}`);
              }
            }
            // TODO: technically rescan is only relevant/available for remote drives
            // such as iscsi etc, should probably limit this call as appropriate
            // for now crudely checking the scenario inside the method itself
            await filesystem.rescanDevice(sdevice);
          }

          // let things settle
          // it appears the dm devices can take a second to figure things out
          if (is_device_mapper || true) {
            await GeneralUtils.sleep(2000);
          }

          if (is_formatted && access_type == "mount") {
            fs_info = await filesystem.getDeviceFilesystemInfo(device);
            fs_type = fs_info.type;
            if (fs_type) {
              switch (fs_type) {
                case "ext3":
                case "ext4":
                case "ext4dev":
                  //await filesystem.checkFilesystem(device, fs_info.type);
                  await filesystem.expandFilesystem(device, fs_type);
                  break;
                case "btrfs":
                case "xfs":
                  let mount_info = await mount.getMountDetails(device_path);
                  if (["btrfs", "xfs"].includes(mount_info.fstype)) {
                    //await filesystem.checkFilesystem(device, fs_info.type);
                    await filesystem.expandFilesystem(device_path, fs_type);
                  }
                  break;
                case "exfat":
                case "ntfs":
                case "vfat":
                  // TODO: return error here, cannot be expanded while online
                  //await filesystem.checkFilesystem(device, fs_info.type);
                  //await filesystem.expandFilesystem(device, fs_type);
                  break;
                default:
                  // unsupported filesystem
                  throw new GrpcError(
                    grpc.status.FAILED_PRECONDITION,
                    `unsupported/unknown filesystem ${fs_type}`
                  );
              }
            }
          } else {
            //block device unformatted
            return {};
          }
        } else {
          // not block device
          return {};
        }

        break;
      case NODE_OS_DRIVER_WINDOWS: {
        const WindowsUtils = require("../utils/windows").Windows;
        const wutils = new WindowsUtils();

        let node_attach_driver;
        let win_volume_path =
          filesystem.covertUnixSeparatorToWindowsSeparator(volume_path);

        // ensure path is mounted
        result = await filesystem.pathExists(win_volume_path);
        if (!result) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `volume_path ${win_volume_path} is not currently mounted`
          );
        }

        let target = (await wutils.GetRealTarget(win_volume_path)) || "";
        if (target.startsWith("\\\\")) {
          node_attach_driver = "smb";
        }
        if (target.startsWith("\\\\?\\Volume")) {
          if (await wutils.VolumeIsIscsi(target)) {
            node_attach_driver = "iscsi";
          }
        }

        if (!node_attach_driver) {
          // nothing we care about
          node_attach_driver = "bypass";
        }

        switch (node_attach_driver) {
          case "smb":
            // noop
            break;
          case "iscsi":
            // rescan devices
            await wutils.UpdateHostStorageCache();
            await wutils.ResizeVolume(target);
            break;
          case "bypass":
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }

        break;
      }
      case NODE_OS_DRIVER_CSI_PROXY:
        const csiProxyClient = driver.getDefaultCsiProxyClientInstance();
        const volume_context = await driver.getDerivedVolumeContext(call);
        if (!volume_context) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `unable to retrieve volume_context for volume: ${volume_id}`
          );
        }

        const node_attach_driver = volume_context.node_attach_driver;

        // ensure path is mounted
        result = await csiProxyClient.FilesystemPathExists(volume_path);
        if (!result) {
          throw new GrpcError(
            grpc.status.NOT_FOUND,
            `volume_path ${volume_path} is not currently mounted`
          );
        }

        switch (node_attach_driver) {
          case "iscsi":
            const node_volume_id =
              await csiProxyClient.getVolumeIdFromIscsiTarget(
                volume_context.portal,
                volume_context.iqn
              );
            const disk_number =
              await csiProxyClient.getDiskNumberFromIscsiTarget(
                volume_context.portal,
                volume_context.iqn
              );

            if (node_volume_id) {
              const required_bytes = _.get(
                call.request,
                "capacity_range.required_bytes"
              );
              if (required_bytes) {
                await csiProxyClient.executeRPC("disk", "Rescan");
                try {
                  await csiProxyClient.executeRPC("volume", "ResizeVolume", {
                    volume_id: node_volume_id,
                    resize_bytes: 0,
                  });
                } catch (e) {
                  let details = _.get(e, "details", "");
                  // seems to be a false positive
                  if (
                    !details.includes(
                      "The size of the extent is less than the minimum of 1MB"
                    )
                  ) {
                    throw e;
                  }

                  await csiProxyClient.executeRPC("disk", "GetDiskStats", {
                    disk_number,
                  });

                  result = await csiProxyClient.executeRPC(
                    "volume",
                    "GetVolumeStats",
                    {
                      volume_id: node_volume_id,
                    }
                  );

                  let diff = Math.abs(result.total_bytes - required_bytes);
                  let percentage_diff = parseInt((diff / required_bytes) * 100);
                  /**
                   * 15MB is used by the 1ast partition on the initialized disk
                   *
                   * 100MB
                   * TODO: possibly change this to a percentage instead of absolute numbers
                   */
                  let max_delta = 104857600;
                  driver.ctx.logger.debug(
                    "resize diff %s (%s%%)",
                    diff,
                    percentage_diff
                  );
                  if (diff > max_delta) {
                    throw new GrpcError(
                      grpc.status.OUT_OF_RANGE,
                      `expanded size ${result.total_bytes} is too far off (${diff}) from requested size (${required_bytes})`
                    );
                  }
                }
              }
            } else {
              throw new GrpcError(grpc.status.NOT_FOUND, `cannot find volume`);
            }
            break;
          default:
            throw new GrpcError(
              grpc.status.INVALID_ARGUMENT,
              `unknown/unsupported node_attach_driver: ${node_attach_driver}`
            );
        }
        break;
      default:
        throw new GrpcError(
          grpc.status.UNIMPLEMENTED,
          `unkown NODE OS DRIVER: ${driver.__getNodeOsDriver()}`
        );
    }

    return {};
  }
}

module.exports.CsiBaseDriver = CsiBaseDriver;
