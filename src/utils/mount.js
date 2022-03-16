const cp = require("child_process");
const { Filesystem } = require("../utils/filesystem");

// avoid using avail,size,used as it causes hangs when the fs is stale
FINDMNT_COMMON_OPTIONS = [
  "--output",
  "source,target,fstype,label,options",
  "-b",
  "-J",
  "--nofsroot", // prevents unwanted behavior with cifs volumes
];

const DEFAULT_TIMEOUT = process.env.MOUNT_DEFAULT_TIMEOUT || 30000;

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

    if (!options.paths.chroot) {
      options.paths.chroot = "/usr/sbin/chroot";
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
  async getMountDetails(path, extraOutputProperties = [], extraArgs = []) {
    const mount = this;
    let args = [];
    const common_options = JSON.parse(JSON.stringify(FINDMNT_COMMON_OPTIONS));
    if (extraOutputProperties.length > 0) {
      common_options[1] =
        common_options[1] + "," + extraOutputProperties.join(",");
    }

    args = args.concat(["--mountpoint", path]);
    args = args.concat(common_options);
    args = args.concat(extraArgs);
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
   * parse a mount options string into an array
   *
   * @param {*} options
   * @returns
   */
  async parseMountOptions(options) {
    if (!options) {
      return [];
    }

    if (Array.isArray(options)) {
      return options;
    }

    options = options.split(",");
    return options;
  }

  /**
   * Given the set of mount options and sought after option, return true if the option is present
   *
   * @param {*} options
   * @param {*} option
   * @returns
   */
  async getMountOptionPresent(options, option) {
    const mount = this;

    if (!Array.isArray(options)) {
      options = await mount.parseMountOptions(options);
    }

    for (let i of options) {
      let parts = i.split("=", 2);
      if (parts[0] == option) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the value of the given mount option
   *
   * if the mount option is present by has no value null is returned
   * if the mount option is NOT present undefined is returned
   * is the mount option has a value that value is returned
   *
   * @param {*} options
   * @param {*} option
   * @returns
   */
  async getMountOptionValue(options, option) {
    const mount = this;

    if (!Array.isArray(options)) {
      options = await mount.parseMountOptions(options);
    }

    for (let i of options) {
      let parts = i.split("=", 2);
      if (parts[0] == option) {
        if (typeof parts[1] === "undefined") {
          return null;
        } else {
          return parts[1];
        }
      }
    }

    return undefined;
  }

  /**
   * Get mount optsion for a given path
   *
   * @param {*} path
   * @returns Array
   */
  async getMountOptions(path) {
    const mount = this;
    let details = await mount.getMountDetails(path, [], ["-m"]);

    return await mount.parseMountOptions(details.options);
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

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const mount = this;
    args = args || [];

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

    return new Promise((resolve, reject) => {
      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr, timeout: false };

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

module.exports.Mount = Mount;
