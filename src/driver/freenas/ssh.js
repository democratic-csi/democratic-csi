const _ = require("lodash");
const semver = require("semver");

const { ControllerZfsBaseDriver } = require("../controller-zfs");
const SshClient = require("../../utils/zfs_ssh_exec_client").SshClient;
const { Zetabyte, ZfsSshProcessManager } = require("../../utils/zfs");
const WebSocketClient = require("./websocket").Client;
const TrueNASWebSocketApiClient = require("./websocket/api").Api;
const FreeNASApiShareHelper =
  require("./websocket/share").FreeNASApiShareHelper;

// used for in-memory cache of the version info
const __REGISTRY_NS__ = "FreeNASSshDriver";

class FreeNASSshDriver extends ControllerZfsBaseDriver {
  /**
   * Ensure sane options are used etc
   * true = ready
   * false = not ready, but progressiong towards ready
   * throw error = faulty setup
   *
   * @param {*} call
   */
  async Probe(call) {
    const driver = this;

    if (driver.ctx.args.csiMode.includes("controller")) {
      const webSocketClient = await driver.getWebSocketClient();
      const apiClient = await driver.getTrueNASWebSocketApiClient();

      try {
        await webSocketClient.waitauthenticated(10 * 1000);
      } catch (err) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `TrueNAS api is not authenticated: ${String(err)}`,
        );
      }

      let version;
      try {
        version = await apiClient.getSystemVersionSemver();
      } catch (err) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `TrueNAS api is unavailable: ${String(err)}`,
        );
      }

      if (!semver.satisfies(version, ">=26")) {
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `driver is only available with TrueNAS version >=26`,
        );
      }

      return super.Probe(...arguments);
    } else {
      return super.Probe(...arguments);
    }
  }

  getExecClient() {
    return this.ctx.registry.get(`${__REGISTRY_NS__}:exec_client`, () => {
      return new SshClient({
        logger: this.ctx.logger,
        connection: this.options.sshConnection,
      });
    });
  }

  async getZetabyte() {
    return this.ctx.registry.getAsync(`${__REGISTRY_NS__}:zb`, async () => {
      const sshClient = this.getExecClient();
      const options = {};
      options.executor = new ZfsSshProcessManager(sshClient);
      options.idempotent = true;
      options.sudo = _.get(this.options, "zfs.cli.sudoEnabled", false);
      if (typeof this.setZetabyteCustomOptions === "function") {
        await this.setZetabyteCustomOptions(options);
      }

      options.paths = options.paths || {};
      options.paths = Object.assign(
        {},
        options.paths,
        _.get(this.options, "zfs.cli.paths", {}),
      );

      return new Zetabyte(options);
    });
  }

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
      case "freenas-nvmeof":
      case "truenas-nvmeof":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.options.driver);
    }
  }

  async setZetabyteCustomOptions(options) {
    // const major = await this.getSystemVersionMajor();
    // const isScale = await this.getIsScale();
    // if (!isScale && Number(major) >= 12) {
    //   options.paths = {
    //     zfs: "/usr/local/sbin/zfs",
    //     zpool: "/usr/local/sbin/zpool",
    //     sudo: "/usr/local/bin/sudo",
    //     chroot: "/usr/sbin/chroot",
    //   };
    // } else if (isScale) {
    //   if (Number(major) >= 25) {
    //     options.paths = {
    //       zfs: "/usr/sbin/zfs",
    //       zpool: "/usr/sbin/zpool",
    //       sudo: "/usr/bin/sudo",
    //       chroot: "/usr/sbin/chroot",
    //     };
    //   } else {
    //     options.paths = {
    //       zfs: "/usr/local/sbin/zfs",
    //       zpool: "/usr/local/sbin/zpool",
    //       sudo: "/usr/bin/sudo",
    //       chroot: "/usr/sbin/chroot",
    //     };
    //   }
    // }
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
      case "freenas-nvmeof":
      case "truenas-nvmeof":
        return "nvmeof";
      default:
        throw new Error("unknown driver: " + this.options.driver);
    }
  }

  async getWebSocketClient() {
    return this.ctx.registry.get(
      `${__REGISTRY_NS__}:websocket_client`,
      async () => {
        const client = new WebSocketClient(
          this.options.httpConnection,
          this.ctx.logger,
        );
        await client.connect();
        await client.waitauthenticated();

        return client;
      },
    );
  }

  async getTrueNASWebSocketApiClient() {
    return this.ctx.registry.getAsync(
      `${__REGISTRY_NS__}:websocket_api_client`,
      async () => {
        const webSocketClient = await this.getWebSocketClient();
        return new TrueNASWebSocketApiClient(webSocketClient);
      },
    );
  }

  /**
   * should create any necessary share resources
   * should set the SHARE_VOLUME_CONTEXT_PROPERTY_NAME propery
   *
   * @param {*} datasetName
   */
  async createShare(call, datasetName) {
    const driver = this;
    const helper = new FreeNASApiShareHelper(driver);
    return helper.createShare(call, datasetName);
  }

  async deleteShare(call, datasetName) {
    const driver = this;
    const helper = new FreeNASApiShareHelper(driver);
    return helper.deleteShare(call, datasetName);
  }

  async expandVolume(call, datasetName) {
    const driver = this;
    const helper = new FreeNASApiShareHelper(driver);
    return helper.expandVolume(call, datasetName);
  }
}

module.exports.FreeNASSshDriver = FreeNASSshDriver;
