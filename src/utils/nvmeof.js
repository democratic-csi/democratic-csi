const cp = require("child_process");
const { hostname_lookup, trimchar } = require("./general");
const URI = require("uri-js");
const querystring = require("querystring");

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

    if (nvmeof.options.logger) {
      nvmeof.logger = nvmeof.options.logger;
    } else {
      nvmeof.logger = console;
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
    let result = await nvmeof.exec(nvmeof.options.paths.nvme, args);
    return result.parsed;
  }

  /**
   * Discover NVMeoF subsystems
   *
   * @param {*} transport
   * @param {*} args
   * @returns
   */
  async discover(transport, args = []) {
    const nvmeof = this;
    transport = await nvmeof.parseTransport(transport);

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

    args.unshift("discover", "-o", "json", ...transport_args);
    let result = await nvmeof.exec(nvmeof.options.paths.nvme, args);
    return result.parsed;
  }

  /**
   * Connect to NVMeoF subsystem
   *
   * @param {*} args
   */
  async connectByNQNTransport(nqn, transport, args = []) {
    const nvmeof = this;
    transport = await nvmeof.parseTransport(transport);

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

    if (transport.args) {
      for (let arg in transport.args) {
        let value = transport.args[arg];
        if (!arg.startsWith("-")) {
          arg = `--${arg}`;
        }
  
        transport_args.push(arg, value);
      }
    }

    args.unshift("connect", "--nqn", nqn, ...transport_args);

    try {
      await nvmeof.exec(nvmeof.options.paths.nvme, args);
    } catch (err) {
      if (
        err.stderr &&
        (err.stderr.includes("already connnected") ||
          err.stderr.includes("Operation already in progress"))
      ) {
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

  async deviceIsNamespaceDevice(device) {
    const nvmeof = this;
    device = device.replace("/dev/", "");
    const subsystems = await nvmeof.getSubsystems();
    for (let subsystem of subsystems) {
      // check subsystem namespaces
      if (subsystem.Namespaces) {
        for (let namespace of subsystem.Namespaces) {
          if (namespace.NameSpace == device) {
            return true;
          }
        }
      }

      // check controller namespaces
      if (subsystem.Controllers) {
        for (let controller of subsystem.Controllers) {
          if (controller.Namespaces) {
            for (let namespace of controller.Namespaces) {
              if (namespace.NameSpace == device) {
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  async deviceIsControllerDevice(device) {
    const nvmeof = this;
    device = device.replace("/dev/", "");
    const subsystems = await nvmeof.getSubsystems();
    for (let subsystem of subsystems) {
      if (subsystem.Controllers) {
        for (let controller of subsystem.Controllers) {
          if (controller.Controller == device) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async parseTransport(transport) {
    if (typeof transport === "object") {
      return transport;
    }

    transport = transport.trim();
    const parsed = URI.parse(transport);
    let args = querystring.parse(parsed.query);

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
      case "tcp":
        /**
         * kernel stores value as ip, so if address passed as hostname then
         * translate to ip address
         *
         * TODO: this could be brittle
         */
        let lookup = await hostname_lookup(address);
        if (lookup) {
          address = lookup;
        }
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
      args,
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
    transport = await nvmeof.parseTransport(transport);
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
    transport = await nvmeof.parseTransport(transport);
    let controller = await nvmeof.getControllerByTransportNQN(transport, nqn);
    if (controller) {
      return `/dev/${controller.Controller}`;
    }
  }

  async getSubsystems() {
    const nvmeof = this;
    let result = await nvmeof.list(["-v"]);

    return nvmeof.getNormalizedSubsystems(result);
  }

  /**
   * used to normalize subsystem list/response across different versions of nvme-cli
   *
   * @param {*} result
   * @returns
   */
  async getNormalizedSubsystems(result) {
    let subsystems = [];

    for (let device of result.Devices) {
      if (Array.isArray(device.Subsystems)) {
        subsystems = subsystems.concat(device.Subsystems);
      } else if (device.Subsystem) {
        // nvme-cli 1.x support
        subsystems.push(device);
      }
    }

    return subsystems;
  }

  async getSubsystemByNQN(nqn) {
    const nvmeof = this;
    const subsystems = await nvmeof.getSubsystems();
    for (let subsystem of subsystems) {
      if (subsystem.SubsystemNQN == nqn) {
        return subsystem;
      }
    }

    nvmeof.logger.warn(`failed to find subsystem for nqn: ${nqn}`);
  }

  async getControllersByNamespaceDeviceName(name) {
    const nvmeof = this;
    name = name.replace("/dev/", "");
    let nativeMultipathEnabled = await nvmeof.nativeMultipathEnabled();
    const subsystems = await nvmeof.getSubsystems();

    if (nativeMultipathEnabled) {
      // using per-subsystem namespace
      for (let subsystem of subsystems) {
        if (subsystem.Namespaces) {
          for (let namespace of subsystem.Namespaces) {
            if (namespace.NameSpace == name) {
              return subsystem.Controllers;
            }
          }
        }
      }
    } else {
      // using per-controller namespace
      for (let subsystem of subsystems) {
        if (subsystem.Controllers) {
          for (let controller of subsystem.Controllers) {
            if (controller.Namespaces) {
              for (let namespace of controller.Namespaces) {
                if (namespace.NameSpace == name) {
                  return subsystem.Controllers;
                }
              }
            }
          }
        }
      }
    }

    nvmeof.logger.warn(`failed to find controllers for device: ${name}`);
    return [];
  }

  async getControllerByTransportNQN(transport, nqn) {
    const nvmeof = this;
    transport = await nvmeof.parseTransport(transport);
    let subsystem = await nvmeof.getSubsystemByNQN(nqn);
    if (subsystem) {
      for (let controller of subsystem.Controllers) {
        if (controller.Transport != transport.type) {
          continue;
        }

        let controllerAddress = controller.Address;
        /**
         * For backwards compatibility with older nvme-cli versions (at least < 2.2.1)
         * old: "Address":"traddr=127.0.0.1 trsvcid=4420"
         * new: "Address":"traddr=127.0.0.1,trsvcid=4420"
         */
        controllerAddress = controllerAddress.replace(
          new RegExp(/ ([a-z_]*=)/, "g"),
          ",$1"
        );
        let parts = controllerAddress.split(",");

        let traddr;
        let trsvcid;
        for (let i_part of parts) {
          let i_parts = i_part.split("=");
          switch (i_parts[0].trim()) {
            case "traddr":
              traddr = i_parts[1].trim();
              break;
            case "trsvcid":
              trsvcid = i_parts[1].trim();
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

    nvmeof.logger.warn(
      `failed to find controller for transport: ${JSON.stringify(
        transport
      )}, nqn: ${nqn}`
    );
  }

  async nqnByNamespaceDeviceName(name) {
    const nvmeof = this;
    name = name.replace("/dev/", "");
    let nativeMultipathEnabled = await nvmeof.nativeMultipathEnabled();
    const subsystems = await nvmeof.getSubsystems();

    if (nativeMultipathEnabled) {
      // using per-subsystem namespace
      for (let subsystem of subsystems) {
        if (subsystem.Namespaces) {
          for (let namespace of subsystem.Namespaces) {
            if (namespace.NameSpace == name) {
              return subsystem.SubsystemNQN;
            }
          }
        }
      }
    } else {
      // using per-controller namespace
      for (let subsystem of subsystems) {
        if (subsystem.Controllers) {
          for (let controller of subsystem.Controllers) {
            if (controller.Namespaces) {
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

    nvmeof.logger.warn(`failed to find nqn for device: ${name}`);
  }

  devicePathByModelNumberSerialNumber(modelNumber, serialNumber) {
    modelNumber = modelNumber.replaceAll(" ", "_");
    serialNumber = serialNumber.replaceAll(" ", "_");
    return `/dev/disk/by-id/nvme-${modelNumber}_${serialNumber}`;
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

    nvmeof.logger.verbose(
      "executing nvmeof command: %s %s",
      command,
      args.join(" ")
    );

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
