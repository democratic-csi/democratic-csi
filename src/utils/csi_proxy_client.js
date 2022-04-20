const _ = require("lodash");
const grpc = require("./grpc").grpc;
const protoLoader = require("@grpc/proto-loader");

const PROTO_BASE_PATH = __dirname + "/../../csi_proxy_proto";

/**
 * leave connection null as by default the named pipe is derrived
 */
const DEFAULT_SERVICES = {
  filesystem: { version: "v1", connection: null },
  disk: { version: "v1", connection: null },
  volume: { version: "v1", connection: null },
  smb: { version: "v1", connection: null },
  system: { version: "v1alpha1", connection: null },
  iscsi: { version: "v1alpha2", connection: null },
};

function capitalize(s) {
  return s && s[0].toUpperCase() + s.slice(1);
}

class CsiProxyClient {
  constructor(options = {}) {
    this.clients = {};

    // initialize all clients
    const services = Object.assign(
      {},
      DEFAULT_SERVICES,
      options.services || {}
    );

    const pipePrefix = options.pipe_prefix || "csi-proxy";

    for (const serviceName in services) {
      const service = services[serviceName];
      const serviceVersion =
        service.version || DEFAULT_SERVICES[serviceName].version;
      const serviceConnection =
        service.connection ||
        `\\\\.\\\\pipe\\\\${pipePrefix}-${serviceName}-${serviceVersion}`;

      const PROTO_PATH = `/${PROTO_BASE_PATH}/${serviceName}/${serviceVersion}/api.proto`;
      const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [__dirname + "/../csi_proxy_proto"],
      });
      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
      const serviceInstance = new protoDescriptor[serviceVersion][
        capitalize(serviceName)
      ](serviceConnection, grpc.credentials.createInsecure());
      this.clients[serviceName] = serviceInstance;
    }
  }

  async executeRPC(serviceName, methodName, options = {}) {
    function rescursivePathFixer(obj) {
      for (const k in obj) {
        if (typeof obj[k] == "object" && obj[k] !== null) {
          rescursivePathFixer(obj[k]);
        } else {
          if (k.includes("path")) {
            obj[k] = obj[k].replaceAll("/", "\\");
          }
        }
      }
    }

    rescursivePathFixer(options);

    const cleansedOptions = JSON.parse(JSON.stringify(options));
    // This function handles arrays and objects
    function recursiveCleanse(obj) {
      for (const k in obj) {
        if (typeof obj[k] == "object" && obj[k] !== null) {
          recursiveCleanse(obj[k]);
        } else {
          if (
            k.includes("secret") ||
            k.includes("username") ||
            k.includes("password")
          ) {
            obj[k] = "redacted";
          }
        }
      }
    }
    recursiveCleanse(cleansedOptions);

    console.log(
      "csi-proxy request %s/%s - data: %j",
      capitalize(serviceName),
      methodName,
      cleansedOptions
    );

    return new Promise((resolve, reject) => {
      const functionRef = this.clients[serviceName.toLowerCase()][methodName];
      if (!functionRef) {
        reject(
          new Error(
            `missing method ${methodName} on service ${capitalize(serviceName)}`
          )
        );
        return;
      }

      this.clients[serviceName.toLowerCase()][methodName](
        options,
        (error, data) => {
          console.log(
            "csi-proxy response %s/%s - error: %j, data: %j",
            capitalize(serviceName),
            methodName,
            error,
            data
          );

          if (error) {
            reject(error);
          }

          resolve(data);
        }
      );
    });
  }

  /**
   * Returns a disk_number if the target has 0 or 1 disks
   *
   * @param {*} target_portal
   * @param {*} iqn
   * @returns
   */
  async getDiskNumberFromIscsiTarget(target_portal, iqn) {
    let result;

    if (typeof target_portal != "object") {
      target_portal = {
        target_address: target_portal.split(":")[0],
        target_port: target_portal.split(":")[1] || 3260,
      };
    }

    // get device
    try {
      result = await this.executeRPC("iscsi", "GetTargetDisks", {
        target_portal,
        iqn,
      });
    } catch (e) {
      let details = _.get(e, "details", "");
      if (!details.includes("ObjectNotFound")) {
        throw e;
      }
    }

    let diskIds = _.get(result, "diskIDs", []);
    if (diskIds.length > 1) {
      throw new Error(
        `${diskIds.length} disks on the target, no way to know which is the relevant disk`
      );
    }

    return diskIds[0];
  }

  /**
   * Returns a volume_id if the disk has 0 or 1 volumes
   *
   * @param {*} disk_number
   * @returns
   */
  async getVolumeIdFromDiskNumber(disk_number) {
    let result;

    if (disk_number == 0 || disk_number > 0) {
      result = await this.executeRPC("volume", "ListVolumesOnDisk", {
        disk_number,
      });

      let volume_ids = _.get(result, "volume_ids", []);
      /**
       * the 1st partition is a sort of system partion and is ""
       * usually around 15MB in size
       */
      volume_ids = volume_ids.filter((item) => {
        return Boolean(item);
      });

      if (volume_ids.length > 1) {
        throw new Error(
          `${volume_ids.length} volumes on the disk, no way to know which is the relevant volume`
        );
      }

      // ok of null/undefined
      return volume_ids[0];
    }
  }

  /**
   * Return a volume_id if the target and disk both have 0 or 1 entries
   *
   * @param {*} target_portal
   * @param {*} iqn
   * @returns
   */
  async getVolumeIdFromIscsiTarget(target_portal, iqn) {
    const disk_number = await this.getDiskNumberFromIscsiTarget(...arguments);
    return await this.getVolumeIdFromDiskNumber(disk_number);
  }

  async FilesystemPathExists(path) {
    let result;
    try {
      result = await this.executeRPC("filesystem", "PathExists", {
        path,
      });

      return result.exists;
    } catch (e) {
      let details = _.get(e, "details", "");
      if (details.includes("not an absolute Windows path")) {
        return false;
      } else {
        throw e;
      }
    }
  }

  async FilesystemIsSymlink(path) {
    let result;
    try {
      result = await this.executeRPC("filesystem", "IsSymlink", {
        path,
      });

      return result.is_symlink;
    } catch (e) {
      let details = _.get(e, "details", "");
      if (details.includes("not an absolute Windows path")) {
        return false;
      } else {
        throw e;
      }
    }
  }
}

module.exports.CsiProxyClient = CsiProxyClient;
