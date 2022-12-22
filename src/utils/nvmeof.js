const cp = require("child_process");
const { trimchar } = require("./general");
const URI = require("uri-js");
const { deleteItems } = require("@kubernetes/client-node");

const DEFAULT_TIMEOUT = process.env.NVMEOF_DEFAULT_TIMEOUT || 30000;

class NVMEoF {
  constructor(options = {}) {
    const nvmeof = this;
    nvmeof.options = options;

    options.paths = options.paths || {};
    if (!options.paths.nvme) {
      options.paths.nvme = "nvme";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }
  }

  /**
   * List all NVMe devices and namespaces on machine
   *
   * @param {*} args
   */
  async list(args = []) {
    const nvmeof = this;
    args.unshift("list", "-o", "json");
    let result = await nvmeof.exec(nvmeof.options.paths.nvme, args);
    return result.parsed;
  }

  /**
   * List nvme subsystems
   *
   * @param {*} args
   */
  async listSubsys(args = []) {
    const nvmeof = this;
    args.unshift("list-subsys", "-o", "json");
    await nvmeof.exec(nvmeof.options.paths.nvme, args);
  }

  /**
   * Connect to NVMeoF subsystem
   *
   * @param {*} args
   */
  async connectByNQNTransport(nqn, transport, args = []) {
    const nvmeof = this;
    transport = nvmeof.parseTransport(transport);

    let transport_args = [];
    if (transport.type) {
      transport_args.push("--transport", transport.type);
    }
    if (transport.address) {
      transport_args.push("--traddr", transport.address);
    }
    if (transport.service) {
      transport_args.push("--trsvcid", transport.service);
    }

    args.unshift("connect", "--nqn", nqn, ...transport_args);

    try {
      await nvmeof.exec(nvmeof.options.paths.nvme, args);
    } catch (err) {
      if (err.stderr && err.stderr.includes("already connnected")) {
        // idempotent
      } else {
        throw err;
      }
    }
  }

  /**
   * Disconnect from NVMeoF subsystem
   *
   * @param {*} args
   */
  async disconnectByNQN(nqn, args = []) {
    const nvmeof = this;
    args.unshift("disconnect", "--nqn", nqn);
    await nvmeof.exec(nvmeof.options.paths.nvme, args);
  }

  /**
   * Disconnect from NVMeoF subsystem
   *
   * @param {*} args
   */
  async disconnectByDevice(device, args = []) {
    const nvmeof = this;
    args.unshift("disconnect", "--device", device);
    await nvmeof.exec(nvmeof.options.paths.nvme, args);
  }

  /**
   * Rescans the NVME namespaces
   *
   * @param {*} device
   * @param {*} args
   */
  async rescanNamespace(device, args = []) {
    const nvmeof = this;
    args.unshift("ns-rescan", device);
    await nvmeof.exec(nvmeof.options.paths.nvme, args);
  }

  parseTransport(transport) {
    if (typeof transport === "object") {
      return transport;
    }

    transport = transport.trim();
    const parsed = URI.parse(transport);

    let type = parsed.scheme;
    let address = parsed.host;
    let service;
    switch (parsed.scheme) {
      case "fc":
      case "rdma":
      case "tcp":
        type = parsed.scheme;
        break;
      default:
        throw new Error(`unknown nvme transport type: ${parsed.scheme}`);
    }

    switch (type) {
      case "fc":
        address = trimchar(address, "[");
        address = trimchar(address, "]");
        break;
    }

    switch (type) {
      case "rdma":
      case "tcp":
        service = parsed.port;

        if (!service) {
          service = 4420;
        }
        break;
    }

    return {
      type,
      address,
      service,
    };
  }

  async nativeMultipathEnabled() {
    const nvmeof = this;
    let result = await nvmeof.exec("cat", [
      "/sys/module/nvme_core/parameters/multipath",
    ]);
    return result.stdout.trim() == "Y";
  }

  async namespaceDevicePathByTransportNQNNamespace(transport, nqn, namespace) {
    const nvmeof = this;
    transport = nvmeof.parseTransport(transport);
    let nativeMultipathEnabled = await nvmeof.nativeMultipathEnabled();
    if (nativeMultipathEnabled) {
      let subsystem = await nvmeof.getSubsystemByNQN(nqn);
      if (subsystem) {
        for (let i_namespace of subsystem.Namespaces) {
          if (i_namespace.NSID != namespace) {
            continue;
          } else {
            return `/dev/${i_namespace.NameSpace}`;
          }
        }
      }
    } else {
      let controller = await nvmeof.getControllerByTransportNQN(transport, nqn);
      if (controller) {
        for (let i_namespace of controller.Namespaces) {
          if (i_namespace.NSID != namespace) {
            continue;
          } else {
            return `/dev/${i_namespace.NameSpace}`;
          }
        }
      }
    }
  }

  async controllerDevicePathByTransportNQN(transport, nqn) {
    const nvmeof = this;
    transport = nvmeof.parseTransport(transport);
    let controller = await nvmeof.getControllerByTransportNQN(transport, nqn);
    if (controller) {
      return `/dev/${controller.Controller}`;
    }
  }

  async getSubsystemByNQN(nqn) {
    const nvmeof = this;
    let result = await nvmeof.list(["-v"]);
    for (let device of result.Devices) {
      for (let subsystem of device.Subsystems) {
        if (subsystem.SubsystemNQN == nqn) {
          return subsystem;
        }
      }
    }
  }

  async getControllerByTransportNQN(transport, nqn) {
    const nvmeof = this;
    transport = nvmeof.parseTransport(transport);
    let subsystem = await nvmeof.getSubsystemByNQN(nqn);
    if (subsystem) {
      for (let controller of subsystem.Controllers) {
        if (controller.Transport != transport.type) {
          continue;
        }

        let controllerAddress = controller.Address;
        let parts = controllerAddress.split(",");

        let traddr;
        let trsvcid;
        for (let i_part of parts) {
          let i_parts = i_part.split("=");
          switch (i_parts[0]) {
            case "traddr":
              traddr = i_parts[1];
              break;
            case "trsvcid":
              trsvcid = i_parts[1];
              break;
          }
        }

        if (traddr != transport.address) {
          continue;
        }

        if (transport.service && trsvcid != transport.service) {
          continue;
        }

        return controller;
      }
    }
  }

  async nqnByNamespaceDeviceName(name) {
    const nvmeof = this;
    name = name.replace("/dev/", "");
    let result = await nvmeof.list(["-v"]);
    let nativeMultipathEnabled = await nvmeof.nativeMultipathEnabled();

    if (nativeMultipathEnabled) {
      for (let device of result.Devices) {
        for (let subsystem of device.Subsystems) {
          for (let namespace of subsystem.Namespaces) {
            if (namespace.NameSpace == name) {
              return subsystem.SubsystemNQN;
            }
          }
        }
      }
    } else {
      for (let device of result.Devices) {
        for (let subsystem of device.Subsystems) {
          for (let controller of subsystem.Controllers) {
            for (let namespace of controller.Namespaces) {
              if (namespace.NameSpace == name) {
                return subsystem.SubsystemNQN;
              }
            }
          }
        }
      }
    }
  }

  devicePathByModelNumberSerialNumber(modelNumber, serialNumber) {
    modelNumber = modelNumber.replaceAll(" ", "_");
    serialNumber = serialNumber.replaceAll(" ", "_");
    return `/dev/disk/by-id/nvme-${modelNumber}_${serialNumber}`;
  }

  devicePathByPortalIQNLUN(portal, iqn, lun) {
    const parsedPortal = this.parsePortal(portal);
    const portalHost = parsedPortal.host
      .replaceAll("[", "")
      .replaceAll("]", "");
    return `/dev/disk/by-path/ip-${portalHost}:${parsedPortal.port}-iscsi-${iqn}-lun-${lun}`;
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const nvmeof = this;
    args = args || [];

    if (nvmeof.options.sudo) {
      args.unshift(command);
      command = nvmeof.options.paths.sudo;
    }

    console.log("executing nvmeof command: %s %s", command, args.join(" "));

    return new Promise((resolve, reject) => {
      const child = nvmeof.options.executor.spawn(command, args, options);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr, timeout: false };
        try {
          result.parsed = JSON.parse(result.stdout);
        } catch (err) {}

        // timeout scenario
        if (code === null) {
          result.timeout = true;
          reject(result);
        }

        if (code) {
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }
}

module.exports.NVMEoF = NVMEoF;
