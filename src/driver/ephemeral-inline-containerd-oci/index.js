const _ = require("lodash");
const fs = require("fs");
const CTR = require("../../utils/ctr").CTR;
const { CsiBaseDriver } = require("../index");
const { GrpcError, grpc } = require("../../utils/grpc");
const { Filesystem } = require("../../utils/filesystem");
const { Mount } = require("../../utils/mount");
const semver = require("semver");
const { parseAll } = require("@codefresh-io/docker-reference");

const __REGISTRY_NS__ = "EphemeralInlineContainerDOciDriver";

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
 */
class EphemeralInlineContainerDOciDriver extends CsiBaseDriver {
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

  /**
   *
   * @returns CTR
   */
  getCTR() {
    return this.ctx.registry.get(`${__REGISTRY_NS__}:ctr`, () => {
      const driver = this;
      let options = _.get(driver.options, "containerd", {});
      options = options || {};
      return new CTR(options);
    });
  }

  assertCapabilities(capabilities) {
    this.ctx.logger.verbose("validating capabilities: %j", capabilities);

    let message = null;
    //[{"access_mode":{"mode":"SINGLE_NODE_WRITER"},"mount":{"mount_flags":["noatime","_netdev"],"fs_type":"nfs"},"access_type":"mount"}]
    const valid = capabilities.every((capability) => {
      if (capability.access_type != "mount") {
        message = `invalid access_type ${capability.access_type}`;
        return false;
      }

      if (capability.mount.fs_type) {
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
    const ctr = driver.getCTR();
    const filesystem = new Filesystem();
    const mount = new Mount();

    const volume_id = call.request.volume_id;
    const staging_target_path = call.request.staging_target_path || "";
    const target_path = call.request.target_path;
    const capability = call.request.volume_capability;
    const access_type = capability.access_type || "mount";
    const readonly = call.request.readonly;
    const volume_context = call.request.volume_context;

    let result;

    let imageReference;
    let imagePullPolicy;
    let imagePlatform;
    let imageUser;
    let labels = {};
    Object.keys(volume_context).forEach(function (key) {
      switch (key) {
        case "image.reference":
          imageReference = volume_context[key];
          break;
        case "image.pullPolicy":
          imagePullPolicy = volume_context[key];
          break;
        case "image.platform":
          imagePlatform = volume_context[key];
          break;
        case "image.user":
          imageUser = volume_context[key];
          break;
      }

      if (key.startsWith("snapshot.label.")) {
        labels[key.replace(/^snapshot\.label\./, "")] = volume_context[key];
      }
    });

    if (!imageReference) {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `image.reference is required`
      );
    }

    if (!volume_id) {
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
      const result = driver.assertCapabilities([capability]);

      if (result.valid !== true) {
        throw new GrpcError(grpc.status.INVALID_ARGUMENT, result.message);
      }
    }

    // create publish directory
    if (!fs.existsSync(target_path)) {
      await fs.mkdirSync(target_path, { recursive: true });
    }

    if (process.platform != "win32") {
      result = await mount.pathIsMounted(target_path);
      if (result) {
        return {};
      }
    }

    // normalize image reference
    let parsedImageReference = parseAll(imageReference);
    //console.log(parsedImageReference);

    /**
     *  const typesTemplates = {
          'digest': ref => `${ref.digest}`,
          'canonical': ref => `${ref.repositoryUrl}@${ref.digest}`,
          'repository': ref => `${ref.repositoryUrl}`,
          'tagged': ref => `${ref.repositoryUrl}:${ref.tag}`,
          'dual': ref => `${ref.repositoryUrl}:${ref.tag}@${ref.digest}`
        };
     * 
     */
    switch (parsedImageReference.type) {
      // repository is not enough for `ctr`
      case "repository":
        imageReference = `${imageReference}:latest`;
        parsedImageReference = parseAll(imageReference);
        break;

      case "canonical":
      case "digest":
      case "dual":
      case "tagged":
        break;
    }

    driver.ctx.logger.debug(
      `imageReference: ${JSON.stringify(parsedImageReference)}`
    );

    imageReference = parsedImageReference.toString();

    // normalize image pull policy
    if (!imagePullPolicy) {
      imagePullPolicy =
        parsedImageReference.type == "tagged" &&
        parsedImageReference.tag == "latest"
          ? "Always"
          : "IfNotPresent";
    }

    driver.ctx.logger.debug(`effective imagePullPolicy: ${imagePullPolicy}`);

    let doPull = true;
    switch (String(imagePullPolicy).toLowerCase()) {
      case "never":
        doPull = false;
        break;
      case "always":
        doPull = true;
        break;
      case "ifnotpresent":
        try {
          await ctr.imageInspect(imageReference);
          doPull = false;
        } catch (err) {}
        break;
    }

    if (doPull) {
      let ctr_pull_args = [];
      if (imagePlatform) {
        ctr_pull_args.push("--platform", imagePlatform);
      }

      if (imageUser) {
        // TODO: decrypt as appropriate
        // --user value, -u value           User[:password] Registry user and password
        ctr_pull_args.push("--user", imageUser);
      }

      await ctr.imagePull(imageReference, ctr_pull_args);
    }

    let ctr_mount_args = [];
    if (imagePlatform) {
      ctr_mount_args.push("--platform", imagePlatform);
    }

    if (Object.keys(labels).length > 0) {
      for (const label in labels) {
        ctr_mount_args.push("--label", `${label}=${labels[label]}`);
      }
    }

    // kubelet will manage readonly for us by bind mounting and ro, it is expected that the driver mounts rw
    // if (!readonly) {
    //   ctr_mount_args.push("--rw");
    // }
    ctr_mount_args.push("--rw");

    await ctr.imageMount(imageReference, target_path, ctr_mount_args);

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
    const driver = this;
    const ctr = driver.getCTR();

    const volume_id = call.request.volume_id;
    const target_path = call.request.target_path;

    if (!volume_id) {
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

    // unmount
    await ctr.imageUnmount(target_path);

    // delete snapshot
    try {
      await ctr.snapshotDelete(target_path);
    } catch (err) {
      if (!err.stderr.includes("does not exist")) {
        throw err;
      }
    }

    // cleanup publish directory
    if (fs.existsSync(target_path) && fs.lstatSync(target_path).isDirectory()) {
      fs.rmSync(target_path, { recursive: true });
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

module.exports.EphemeralInlineContainerDOciDriver =
  EphemeralInlineContainerDOciDriver;
