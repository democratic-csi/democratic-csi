const fs = require("fs");
const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const { Filesystem } = require("../../utils/filesystem");
const registry = require("../../utils/registry");
const semver = require("semver");
const SshClient = require("../../utils/zfs_ssh_exec_client").SshClient;
const { Zetabyte, ZfsSshProcessManager } = require("../../utils/zfs");

// zfs common properties
const MANAGED_PROPERTY_NAME = "democratic-csi:managed_resource";
const SUCCESS_PROPERTY_NAME = "democratic-csi:provision_success";
const VOLUME_CSI_NAME_PROPERTY_NAME = "democratic-csi:csi_volume_name";
const VOLUME_CONTEXT_PROVISIONER_DRIVER_PROPERTY_NAME =
  "democratic-csi:volume_context_provisioner_driver";
const VOLUME_CONTEXT_PROVISIONER_INSTANCE_ID_PROPERTY_NAME =
  "democratic-csi:volume_context_provisioner_instance_id";
const __REGISTRY_NS__ = "ZfsLocalEphemeralInlineDriver";

/**
 * https://github.com/kubernetes/enhancements/blob/master/keps/sig-storage/20190122-csi-inline-volumes.md
 * https://kubernetes-csi.github.io/docs/ephemeral-local-volumes.html
 *
 * Sample calls:
 *  - https://gcsweb.k8s.io/gcs/kubernetes-jenkins/pr-logs/pull/92387/pull-kubernetes-e2e-gce/1280784994997899264/artifacts/_sig-storage_CSI_Volumes/_Driver_csi-hostpath_/_Testpattern_inline_ephemeral_CSI_volume_ephemeral/should_create_read_write_inline_ephemeral_volume/
 *  - https://storage.googleapis.com/kubernetes-jenkins/pr-logs/pull/92387/pull-kubernetes-e2e-gce/1280784994997899264/artifacts/_sig-storage_CSI_Volumes/_Driver_csi-hostpath_/_Testpattern_inline_ephemeral_CSI_volume_ephemeral/should_create_read-only_inline_ephemeral_volume/csi-hostpathplugin-0-hostpath.log
 *
 * inline drivers are assumed to be mount only (no block support)
 * purposely there is no native support for size contraints
 *
 * TODO: support creating zvols and formatting and mounting locally instead of using zfs dataset?
 *
 */
class ZfsLocalEphemeralInlineDriver extends CsiBaseDriver {
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
        "UNKNOWN",
        //"CONTROLLER_SERVICE"
        //"VOLUME_ACCESSIBILITY_CONSTRAINTS"
      ];
    }

    if (!("volume_expansion" in options.service.identity.capabilities)) {
      this.ctx.logger.debug("setting default identity volume_expansion caps");

      options.service.identity.capabilities.volume_expansion = [
        "UNKNOWN",
        //"ONLINE",
        //"OFFLINE"
      ];
    }

    if (!("rpc" in options.service.controller.capabilities)) {
      this.ctx.logger.debug("setting default controller caps");

      options.service.controller.capabilities.rpc = [
        //"UNKNOWN",
        //"CREATE_DELETE_VOLUME",
        //"PUBLISH_UNPUBLISH_VOLUME",
        //"LIST_VOLUMES",
        //"GET_CAPACITY",
        //"CREATE_DELETE_SNAPSHOT",
        //"LIST_SNAPSHOTS",
        //"CLONE_VOLUME",
        //"PUBLISH_READONLY",
        //"EXPAND_VOLUME"
      ];

      if (semver.satisfies(this.ctx.csiVersion, ">=1.3.0")) {
        options.service.controller.capabilities.rpc
          .push
          //"VOLUME_CONDITION",
          //"GET_VOLUME"
          ();
      }

      if (semver.satisfies(this.ctx.csiVersion, ">=1.5.0")) {
        options.service.controller.capabilities.rpc
          .push
          //"SINGLE_NODE_MULTI_WRITER"
          ();
      }
    }

    if (!("rpc" in options.service.node.capabilities)) {
      this.ctx.logger.debug("setting default node caps");
      options.service.node.capabilities.rpc = [
        //"UNKNOWN",
        //"STAGE_UNSTAGE_VOLUME",
        "GET_VOLUME_STATS",
        //"EXPAND_VOLUME",
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

  getSshClient() {
    return registry.get(`${__REGISTRY_NS__}:ssh_client`, () => {
      return new SshClient({
        logger: this.ctx.logger,
        connection: this.options.sshConnection,
      });
    });
  }

  getZetabyte() {
    return registry.get(`${__REGISTRY_NS__}:zb`, () => {
      let sshClient;
      let executor;
      if (this.options.sshConnection) {
        sshClient = this.getSshClient();
        executor = new ZfsSshProcessManager(sshClient);
      }
      return new Zetabyte({
        executor,
        idempotent: true,
        chroot: this.options.zfs.chroot,
        paths: {
          zpool: "/usr/sbin/zpool",
          zfs: "/usr/sbin/zfs",
        },
      });
    });
  }

  getDatasetParentName() {
    let datasetParentName = this.options.zfs.datasetParentName;
    datasetParentName = datasetParentName.replace(/\/$/, "");
    return datasetParentName;
  }

  getVolumeParentDatasetName() {
    let datasetParentName = this.getDatasetParentName();
    datasetParentName += "/v";
    datasetParentName = datasetParentName.replace(/\/$/, "");
    return datasetParentName;
  }

  assertCapabilities(capabilities) {
    // hard code this for now
    const driverZfsResourceType = "filesystem";
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
    const valid = capabilities.every((capability) => {
      switch (driverZfsResourceType) {
        case "filesystem":
          if (capability.access_type != "mount") {
            message = `invalid access_type ${capability.access_type}`;
            return false;
          }

          if (
            capability.mount.fs_type &&
            !["zfs"].includes(capability.mount.fs_type)
          ) {
            message = `invalid fs_type ${capability.mount.fs_type}`;
            return false;
          }

          if (
            capability.mount.mount_flags &&
            capability.mount.mount_flags.length > 0
          ) {
            message = `invalid mount_flags ${capability.mount.mount_flags}`;
            return false;
          }

          if (
            ![
              "UNKNOWN",
              "SINGLE_NODE_WRITER",
              "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
              "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
              "SINGLE_NODE_READER_ONLY",
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
              !["btrfs", "ext3", "ext4", "ext4dev", "xfs"].includes(
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
              "SINGLE_NODE_SINGLE_WRITER", // added in v1.5.0
              "SINGLE_NODE_MULTI_WRITER", // added in v1.5.0
              "SINGLE_NODE_READER_ONLY",
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
   * This should create a dataset with appropriate volume properties, ensuring
   * the mountpoint is the target_path
   *
   * Any volume_context attributes starting with property.<name> will be set as zfs properties
   * 
   * {
      "target_path": "/var/lib/kubelet/pods/f8b237db-19e8-44ae-b1d2-740c9aeea702/volumes/kubernetes.io~csi/my-volume-0/mount",
      "volume_capability": {
        "AccessType": {
          "Mount": {}
        },
        "access_mode": {
          "mode": 1
        }
      },
      "volume_context": {
        "csi.storage.k8s.io/ephemeral": "true",
        "csi.storage.k8s.io/pod.name": "inline-volume-tester-2ptb7",
        "csi.storage.k8s.io/pod.namespace": "ephemeral-468",
        "csi.storage.k8s.io/pod.uid": "f8b237db-19e8-44ae-b1d2-740c9aeea702",
        "csi.storage.k8s.io/serviceAccount.name": "default",
        "foo": "bar"
      },
      "volume_id": "csi-8228252978a824126924de00126e6aec7c989a48a39d577bd3ab718647df5555"
    }
   *
   * @param {*} call
   */
  async NodePublishVolume(call) {
    const driver = this;
    const zb = this.getZetabyte();

    const volume_id = call.request.volume_id;
    const staging_target_path = call.request.staging_target_path || "";
    const target_path = call.request.target_path;
    const capability = call.request.volume_capability;
    const access_type = capability.access_type || "mount";
    const readonly = call.request.readonly;
    const volume_context = call.request.volume_context;

    let datasetParentName = this.getVolumeParentDatasetName();
    let name = volume_id;

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

    if (!target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `target_path is required`
      );
    }

    if (capability) {
      const result = this.assertCapabilities([capability]);

      if (result.valid !== true) {
        throw new GrpcError(grpc.status.INVALID_ARGUMENT, result.message);
      }
    }

    const datasetName = datasetParentName + "/" + name;

    // TODO: support arbitrary values from config
    // TODO: support arbitrary props from volume_context
    let volumeProperties = {};

    // set user-supplied properties
    // this come from volume_context from keys starting with property.<foo>
    const base_key = "property.";
    const prefixLength = `${base_key}`.length;
    Object.keys(volume_context).forEach(function (key) {
      if (key.startsWith(base_key)) {
        let normalizedKey = key.slice(prefixLength);
        volumeProperties[normalizedKey] = volume_context[key];
      }
    });

    // set standard properties
    volumeProperties[VOLUME_CSI_NAME_PROPERTY_NAME] = name;
    volumeProperties[MANAGED_PROPERTY_NAME] = "true";
    volumeProperties[VOLUME_CONTEXT_PROVISIONER_DRIVER_PROPERTY_NAME] =
      driver.options.driver;
    if (driver.options.instance_id) {
      volumeProperties[VOLUME_CONTEXT_PROVISIONER_INSTANCE_ID_PROPERTY_NAME] =
        driver.options.instance_id;
    }
    volumeProperties[SUCCESS_PROPERTY_NAME] = "true";

    // NOTE: setting mountpoint will automatically create the full path as necessary so no need for mkdir etc
    volumeProperties["mountpoint"] = target_path;

    // does not really make sense for ephemeral volumes..but we'll put it here in case
    if (readonly) {
      volumeProperties["readonly"] = "on";
    }

    // set driver config properties
    if (this.options.zfs.properties) {
      Object.keys(driver.options.zfs.properties).forEach(function (key) {
        const value = driver.options.zfs.properties[key]["value"];
        const allowOverride =
          "allowOverride" in driver.options.zfs.properties[key]
            ? driver.options.zfs.properties[key]["allowOverride"]
            : true;

        if (!allowOverride || !(key in volumeProperties)) {
          volumeProperties[key] = value;
        }
      });
    }

    // TODO: catch out of space errors and return specifc grpc message?
    await zb.zfs.create(datasetName, {
      parents: true,
      properties: volumeProperties,
    });

    return {};
  }

  /**
   * This should destroy the dataset and remove target_path as appropriate
   * 
   *{
      "target_path": "/var/lib/kubelet/pods/f8b237db-19e8-44ae-b1d2-740c9aeea702/volumes/kubernetes.io~csi/my-volume-0/mount",
      "volume_id": "csi-8228252978a824126924de00126e6aec7c989a48a39d577bd3ab718647df5555"
    }
   *
   * @param {*} call
   */
  async NodeUnpublishVolume(call) {
    const zb = this.getZetabyte();
    const filesystem = new Filesystem();
    let result;

    const volume_id = call.request.volume_id;
    const target_path = call.request.target_path;

    let datasetParentName = this.getVolumeParentDatasetName();
    let name = volume_id;

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

    if (!target_path) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `target_path is required`
      );
    }

    const datasetName = datasetParentName + "/" + name;

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

    // cleanup publish directory
    result = await filesystem.pathExists(target_path);
    if (result) {
      if (fs.lstatSync(target_path).isDirectory()) {
        result = await filesystem.rmdir(target_path);
      } else {
        result = await filesystem.rm([target_path]);
      }
    }

    return {};
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
        parameters: call.request.parameters,
      },
    };
  }
}

module.exports.ZfsLocalEphemeralInlineDriver = ZfsLocalEphemeralInlineDriver;
