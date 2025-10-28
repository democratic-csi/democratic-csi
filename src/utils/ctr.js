const cp = require("child_process");

class CTR {
  constructor(options = {}) {
    const ctr = this;
    ctr.options = options;

    options.containerd = options.containerd || {};
    if (process.platform != "win32" && options.containerd.address) {
      //options.containerd.address = "/run/containerd/containerd.sock";
      //options.containerd.address;
    }

    if (process.platform == "win32" && options.containerd.windowsAddress) {
      // --address value, -a value    Address for containerd's GRPC server (default: "\\\\.\\pipe\\containerd-containerd") [%CONTAINERD_ADDRESS%]
      options.containerd.address = options.containerd.windowsAddress;
    }

    if (!options.containerd.namespace) {
      //options.containerd.namespace = "default";
    }

    options.paths = options.paths || {};
    if (!options.paths.ctr) {
      options.paths.ctr = "ctr";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }

    if (!options.env) {
      options.env = {};
    }

    if (ctr.options.logger) {
      ctr.logger = ctr.options.logger;
    } else {
      ctr.logger = console;
      console.verbose = function () {
        console.log(...arguments);
      };
    }
  }

  async info() {
    const ctr = this;
    let args = ["info"];
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result.parsed;
  }

  // ctr images pull "${IMAGE}"
  async imagePull(image, args = []) {
    const ctr = this;
    args.unshift("images", "pull");
    args.push(image);
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result.parsed;
  }

  // ctr images mount --rw "${IMAGE}" "${MOUNT_TARGET}"
  async imageMount(image, target, args = []) {
    const ctr = this;
    args.unshift("images", "mount");
    args.push(image, target);
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result;
  }

  // ctr images unmount "${MOUNT_TARGET}"
  async imageUnmount(target, args = []) {
    const ctr = this;
    args.unshift("images", "unmount");
    args.push(target);
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result;
  }

  // ctr image inspect docker.io/library/ubuntu:latest
  async imageInspect(image, args = []) {
    const ctr = this;
    args.unshift("images", "inspect");
    args.push(image);
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result;
  }

  async snapshotList(args = []) {
    const ctr = this;
    args.unshift("snapshot", "list");
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result;
  }

  // ctr snapshots delete [command options] <key> [<key>, ...]
  async snapshotDelete(key) {
    const ctr = this;
    let args = ["snapshot", "delete"];
    args.push(key);
    let result = await ctr.exec(ctr.options.paths.ctr, args);
    return result;
  }

  exec(command, args, options = {}) {
    // if (!options.hasOwnProperty("timeout")) {
    //   options.timeout = DEFAULT_TIMEOUT;
    // }

    const ctr = this;
    args = args || [];

    // --debug

    if (process.platform != "win32" && ctr.options.sudo) {
      args.unshift(command);
      command = ctr.options.paths.sudo;
    }

    options.env = { ...{}, ...ctr.options.env, ...options.env };

    if (ctr.options.containerd.address) {
      options.env.CONTAINERD_ADDRESS = ctr.options.containerd.address;
    }

    if (ctr.options.containerd.namespace) {
      options.env.CONTAINERD_NAMESPACE = ctr.options.containerd.namespace;
    }

    options.env.PATH = process.env.PATH;

    ctr.logger.verbose("executing ctr command: %s %s", command, args.join(" "));

    return new Promise((resolve, reject) => {
      const child = ctr.options.executor.spawn(command, args, options);

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

module.exports.CTR = CTR;
