const cp = require("child_process");
const { Filesystem } = require("../utils/filesystem");

FINDMNT_COMMON_OPTIONS = [
  "--output",
  "source,target,fstype,label,options,avail,size,used",
  "-b",
  "-J",
  "--nofsroot", // prevents unwanted behavior with cifs volumes
];

class Mount {
  constructor(options = {}) {
    const mount = this;
    mount.options = options;

    options.paths = options.paths || {};
    if (!options.paths.mount) {
      options.paths.mount = "mount";
    }

    if (!options.paths.umount) {
      options.paths.umount = "umount";
    }

    if (!options.paths.findmnt) {
      options.paths.findmnt = "findmnt";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.timeout) {
      options.timeout = 10 * 60 * 1000;
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }
  }

  /**
   * findmnt --source <device> --output source,target,fstype,label,options,avail,size,used -b -J
   *
   * @param {*} device
   */
  async deviceIsMounted(device) {
    const filesystem = new Filesystem();
    if (device.startsWith("/")) {
      device = await filesystem.realpath(device);
    }

    const mount = this;
    let args = [];
    args = args.concat(["--source", device]);
    args = args.concat(FINDMNT_COMMON_OPTIONS);
    let result;

    try {
      result = await mount.exec(mount.options.paths.findmnt, args);
    } catch (err) {
      // no results
      if (err.code == 1) {
        return false;
      } else {
        throw err;
      }
    }

    return true;
  }

  /**
   * findmnt --mountpoint / --output source,target,fstype,label,options,avail,size,used -b -J
   *
   * @param {*} device
   */
  async pathIsMounted(path) {
    const mount = this;
    let args = [];
    args = args.concat(["--mountpoint", path]);
    args = args.concat(FINDMNT_COMMON_OPTIONS);
    let result;

    try {
      result = await mount.exec(mount.options.paths.findmnt, args);
    } catch (err) {
      // no results
      if (err.code == 1) {
        return false;
      } else if (
        err.code == 32 &&
        err.stderr &&
        err.stderr.contains("No such file or directory")
      ) {
        return false;
      } else {
        throw err;
      }
    }

    return true;
  }

  /**
   * findmnt --source <device> --mountpoint <path> --output source,target,fstype,label,options,avail,size,used -b -J
   *
   * @param {*} device
   */
  async deviceIsMountedAtPath(device, path) {
    const filesystem = new Filesystem();
    if (device.startsWith("/") && !device.startsWith("//")) {
      device = await filesystem.realpath(device);
    }

    const mount = this;
    let args = [];
    args = args.concat(["--source", device]);
    args = args.concat(["--mountpoint", path]);
    args = args.concat(FINDMNT_COMMON_OPTIONS);
    let result;

    try {
      result = await mount.exec(mount.options.paths.findmnt, args);
    } catch (err) {
      // no results
      if (err.code == 1) {
        return false;
      } else {
        throw err;
      }
    }

    return true;
  }

  /**
   * findmnt --mountpoint / --output source,target,fstype,label,options,avail,size,used -b -J
   *
   * @param {*} path
   */
  async getMountDetails(path) {
    const mount = this;
    let args = [];
    args = args.concat(["--mountpoint", path]);
    args = args.concat(FINDMNT_COMMON_OPTIONS);
    let result;

    try {
      result = await mount.exec(mount.options.paths.findmnt, args);
      const parsed = JSON.parse(result.stdout);
      return parsed.filesystems[0];
    } catch (err) {
      throw err;
    }
  }

  /**
   * Get the device (source) at the given mount point
   *
   * @param {*} path
   */
  async getMountPointDevice(path) {
    const mount = this;
    const result = await mount.getMountDetails(path);
    if (result.fstype == "devtmpfs") {
      // dev[/sdb]
      let source = "/";
      source += result.source;
      source = source.replace("[", "");
      source = source.replace("]", "");

      return source.trim();
    }
    return result.source.trim();
  }

  /**
   * very specifically looking for *devices* vs *filesystems/directories* which were bind mounted
   *
   * @param {*} path
   */
  async isBindMountedBlockDevice(path) {
    const filesystem = new Filesystem();
    const mount = this;

    const is_mounted = await mount.pathIsMounted(path);
    if (!is_mounted) {
      return false;
    }
    const mount_info = await mount.getMountDetails(path);
    const is_block = filesystem.isBlockDevice(path);
    if (mount_info.fstype == "devtmpfs" && is_block) {
      return true;
    }
    return false;
  }

  /**
   * Get the filesystem type at mount point
   *
   * @param {*} path
   */
  async getMountPointFsType(path) {
    const mount = this;
    const result = await mount.getMountDetails(path);
    return result.fstype;
  }

  /**
   * mount [options] <source> <directory>
   *
   * @param {*} source
   * @param {*} target
   * @param {*} options
   */
  async mount(source, target, options = []) {
    const mount = this;
    let args = [];
    args = args.concat(options);
    args = args.concat([source, target]);

    let result;
    try {
      result = await mount.exec(mount.options.paths.mount, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * mount <operation> <mountpoint> [<target>]
   *
   * @param {*} source
   * @param {*} target
   * @param {*} options
   */
  async bindMount(source, target, options = []) {
    const mount = this;
    let args = [];
    args.push("--bind");
    args = args.concat(options);
    args = args.concat([source, target]);

    let result;
    try {
      result = await mount.exec(mount.options.paths.mount, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * umount [options] <source> | <directory>
   *
   * @param {*} target
   * @param {*} options
   */
  async umount(target, options = []) {
    const mount = this;
    let args = [];
    args = args.concat(options);
    args.push(target);

    try {
      await mount.exec(mount.options.paths.umount, args);
    } catch (err) {
      if (err.code == 32) {
        return true;
      } else {
        throw err;
      }
    }
    return true;
  }

  exec(command, args, options) {
    const mount = this;
    args = args || [];

    let timeout;
    let stdout = "";
    let stderr = "";

    if (mount.options.sudo) {
      args.unshift(command);
      command = mount.options.paths.sudo;
    }
    // https://regex101.com/r/FHIbcw/3
    // replace password=foo with password=redacted
    // (?<=password=)(?:([\"'])(?:\\\1|.)*?\1|[^,\s]+)
    const regex = /(?<=password=)(?:([\"'])(?:\\\1|.)*?\1|[^,\s]+)/gi;
    const cleansedLog = `${command} ${args.join(" ")}`.replace(
      regex,
      "redacted"
    );

    console.log("executing mount command: %s", cleansedLog);
    const child = mount.options.executor.spawn(command, args, options);

    let didTimeout = false;
    if (options && options.timeout) {
      timeout = setTimeout(() => {
        didTimeout = true;
        child.kill(options.killSignal || "SIGTERM");
      }, options.timeout);
    }

    return new Promise((resolve, reject) => {
      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr };
        if (timeout) {
          clearTimeout(timeout);
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

module.exports.Mount = Mount;
