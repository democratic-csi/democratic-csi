const cp = require("child_process");
const fs = require("fs");

/**
 * https://github.com/kubernetes/kubernetes/tree/master/pkg/util/mount
 * https://github.com/kubernetes/kubernetes/blob/master/pkg/util/mount/mount_linux.go
 */
class Filesystem {
  constructor(options = {}) {
    const filesystem = this;
    filesystem.options = options;

    options.paths = options.paths || {};

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
   * Attempt to discover if device is a block device
   *
   * @param {*} device
   */
  async isBlockDevice(device) {
    const filesystem = this;

    // nfs paths
    if (!device.startsWith("/")) {
      return false;
    }

    // smb paths
    if (device.startsWith("//")) {
      return false;
    }

    const device_path = await filesystem.realpath(device);
    const blockdevices = await filesystem.getAllBlockDevices();

    return blockdevices.some(async (i) => {
      if ((await filesystem.realpath(i.path)) == device_path) {
        return true;
      }
      return false;
    });
  }

  /**
   * Attempt to discover if the device is a device-mapper device
   *
   * @param {*} device
   */
  async isDeviceMapperDevice(device) {
    const filesystem = this;
    const isBlock = await filesystem.isBlockDevice(device);

    if (!isBlock) {
      return false;
    }

    device = await filesystem.realpath(device);

    return device.includes("dm-");
  }

  async isDeviceMapperSlaveDevice(device) {
    const filesystem = this;
    device = await filesystem.realpath(device);
  }

  /**
   * Get all device-mapper devices (ie: dm-0, dm-1, dm-N...)
   */
  async getAllDeviceMapperDevices() {
    const filesystem = this;
    let result;
    let devices = [];
    let args = [
      "-c",
      'for file in $(ls -la /dev/mapper/* | grep "\\->" | grep -oP "\\-> .+" | grep -oP " .+"); do echo $(F=$(echo $file | grep -oP "[a-z0-9-]+");echo $F":"$(ls "/sys/block/${F}/slaves/");); done;',
    ];

    try {
      result = await filesystem.exec("sh", args);

      for (const dm of result.stdout.trim().split("\n")) {
        if (dm.length < 1) {
          continue;
        }
        devices.push("/dev/" + dm.split(":")[0].trim());
      }
      return devices;
    } catch (err) {
      throw err;
    }
  }

  async getAllDeviceMapperSlaveDevices() {
    const filesystem = this;
    let result;
    let args = [
      "-c",
      'for file in $(ls -la /dev/mapper/* | grep "\\->" | grep -oP "\\-> .+" | grep -oP " .+"); do echo $(F=$(echo $file | grep -oP "[a-z0-9-]+");echo $F":"$(ls "/sys/block/${F}/slaves/");); done;',
    ];
    let slaves = [];

    try {
      result = await filesystem.exec("sh", args);

      for (const dm of result.stdout.trim().split("\n")) {
        if (dm.length < 1) {
          continue;
        }
        const realDevices = dm
          .split(":")[1]
          .split(" ")
          .map((value) => {
            return "/dev/" + value.trim();
          });
        slaves.push(...realDevices);
      }
      return slaves;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Get all slave devices connected to a device-mapper device
   *
   * @param {*} device
   */
  async getDeviceMapperDeviceSlaves(device) {
    const filesystem = this;
    device = await filesystem.realpath(device);
    let device_info = await filesystem.getBlockDevice(device);
    const slaves = [];

    let result;
    let args = [`/sys/block/${device_info.kname}/slaves/`];

    try {
      result = await filesystem.exec("ls", args);

      for (const entry of result.stdout.split("\n")) {
        if (entry.trim().length < 1) {
          continue;
        }

        slaves.push("/dev/" + entry.trim());
      }
      return slaves;
    } catch (err) {
      throw err;
    }
  }

  async getDeviceMapperDeviceFromSlaves(slaves, matchAll = true) {
    const filesystem = this;
    let result;

    // get mapping of dm devices to real devices
    let args = [
      "-c",
      'for file in $(ls -la /dev/mapper/* | grep "\\->" | grep -oP "\\-> .+" | grep -oP " .+"); do echo $(F=$(echo $file | grep -oP "[a-z0-9-]+");echo $F":"$(ls "/sys/block/${F}/slaves/");); done;',
    ];

    result = await filesystem.exec("sh", args);

    for (const dm of result.stdout.trim().split("\n")) {
      if (dm.length < 1) {
        continue;
      }
      const dmDevice = "/dev/" + dm.split(":")[0].trim();
      const realDevices = dm
        .split(":")[1]
        .split(" ")
        .map((value) => {
          return "/dev/" + value.trim();
        });
      const intersectDevices = slaves.filter((value) =>
        realDevices.includes(value)
      );

      if (matchAll === false && intersectDevices.length > 0) {
        return dmDevice;
      }

      // if all 3 have the same elements we have a winner
      if (
        intersectDevices.length == realDevices.length &&
        realDevices.length == slaves.length
      ) {
        return dmDevice;
      }
    }
  }

  /**
   * create symlink
   *
   * @param {*} device
   */
  async symlink(target, link, options = []) {
    const filesystem = this;
    let args = ["-s"];
    args = args.concat(options);
    args = args.concat([target, link]);

    try {
      await filesystem.exec("ln", args);
    } catch (err) {
      throw err;
    }
  }

  /**
   * create symlink
   *
   * @param {*} device
   */
  async rm(options = []) {
    const filesystem = this;
    let args = [];
    args = args.concat(options);

    try {
      await filesystem.exec("rm", args);
    } catch (err) {
      throw err;
    }
  }

  /**
   * touch a path
   * @param {*} path
   */
  async touch(path, options = []) {
    const filesystem = this;
    let args = [];
    args = args.concat(options);
    args.push(path);

    try {
      await filesystem.exec("touch", args);
    } catch (err) {
      throw err;
    }
  }

  /**
   * touch a path
   * @param {*} path
   */
  async dirname(path) {
    const filesystem = this;
    let args = [];
    args.push(path);
    let result;

    try {
      result = await filesystem.exec("dirname", args);
      return result.stdout.trim();
    } catch (err) {
      throw err;
    }
  }

  /**
   * lsblk -a -b -l -J -O
   */
  async getAllBlockDevices() {
    const filesystem = this;
    let args = ["-a", "-b", "-l", "-J", "-O"];
    let result;

    try {
      result = await filesystem.exec("lsblk", args);
      const parsed = JSON.parse(result.stdout);
      return parsed.blockdevices;
    } catch (err) {
      throw err;
    }
  }

  /**
   * lsblk -a -b -l -J -O
   */
  async getBlockDevice(device) {
    const filesystem = this;
    device = await filesystem.realpath(device);
    let args = ["-a", "-b", "-l", "-J", "-O"];
    args.push(device);
    let result;

    try {
      result = await filesystem.exec("lsblk", args);
      const parsed = JSON.parse(result.stdout);
      return parsed.blockdevices[0];
    } catch (err) {
      throw err;
    }
  }

  /**
   * blkid -p -o export <device>
   *
   * @param {*} device
   */
  async deviceIsFormatted(device) {
    const filesystem = this;
    let args = ["-p", "-o", "export", device];
    let result;

    try {
      result = await filesystem.exec("blkid", args);
    } catch (err) {
      if (err.code == 2 && err.stderr.includes("No such device or address")) {
        throw err;
      }

      if (err.code == 2) {
        return false;
      }

      throw err;
    }

    return true;
  }

  /**
   * blkid -p -o export <device>
   *
   * @param {*} device
   */
  async getDeviceFilesystemInfo(device) {
    const filesystem = this;
    let args = ["-p", "-o", "export", device];
    let result;

    try {
      result = await filesystem.exec("blkid", args);
      const entries = result.stdout.trim().split("\n");
      const properties = {};
      let fields, key, value;
      entries.forEach((entry) => {
        fields = entry.split("=");
        key = fields[0].toLowerCase();
        value = fields[1];
        properties[key] = value;
      });

      return properties;
    } catch (err) {
      throw err;
    }
  }

  /**
   * mkfs.<fstype> [<options>] device
   *
   * @param {*} device
   * @param {*} fstype
   * @param {*} options
   */
  async formatDevice(device, fstype, options = []) {
    const filesystem = this;
    let args = [];
    args = args.concat(options);
    switch (fstype) {
      case "vfat":
        args = args.concat(["-I"]);
        break;
    }
    args.push(device);
    let result;

    try {
      result = await filesystem.exec("mkfs." + fstype, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  async realpath(path) {
    const filesystem = this;
    let args = [path];
    let result;

    try {
      result = await filesystem.exec("realpath", args);
      return result.stdout.trim();
    } catch (err) {
      throw err;
    }
  }

  async rescanDevice(device) {
    const filesystem = this;
    let result;
    let device_name;

    result = await filesystem.isBlockDevice(device);
    if (!result) {
      throw new Error(
        `cannot rescan device ${device} because it is not a block device`
      );
    }

    let is_device_mapper_device = await filesystem.isDeviceMapperDevice(device);
    result = await filesystem.realpath(device);

    if (is_device_mapper_device) {
      // multipath -r /dev/dm-0
      result = await filesystem.exec("multipath", ["-r", device]);
    } else {
      device_name = result.split("/").pop();

      // echo 1 > /sys/block/sdb/device/rescan
      const sys_file = `/sys/block/${device_name}/device/rescan`;
      console.log(`executing filesystem command: echo 1 > ${sys_file}`);
      fs.writeFileSync(sys_file, "1");
    }
  }

  /**
   * expand a given filesystem
   *
   * @param {*} device
   * @param {*} fstype
   * @param {*} options
   */
  async expandFilesystem(device, fstype, options = []) {
    const filesystem = this;
    let command;
    let args = [];
    let result;

    switch (fstype.toLowerCase()) {
      case "ext4":
      case "ext3":
      case "ext4dev":
        command = "resize2fs";
        args = args.concat(options);
        args.push(device);
        break;
      case "xfs":
        command = "xfs_growfs";
        args = args.concat(options);
        args.push(device); // in this case should be a mounted path
        break;
      case "vfat":
        // must be unmounted
        command = "fatresize";
        args = args.concat(options);
        args = args.concat(["-s", "max"]);
        args.push(device);
        break;
    }

    try {
      result = await filesystem.exec(command, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * check a given filesystem
   *
   * fsck [options] -- [fs-options] [<filesystem> ...]
   *
   * @param {*} device
   * @param {*} fstype
   * @param {*} options
   * @param {*} fsoptions
   */
  async checkFilesystem(device, fstype, options = [], fsoptions = []) {
    const filesystem = this;
    let command;
    let args = [];
    let result;

    switch (fstype.toLowerCase()) {
      case "ext4":
      case "ext3":
      case "ext4dev":
        command = "fsck";
        args = args.concat(options);
        args.push(device);
        args.push("--");
        args = args.concat(fsoptions);
        args.push("-f");
        args.push("-p");
        break;
      case "xfs":
        command = "xfs_repair";
        args = args.concat(["-o", "force_geometry"]);
        args = args.concat(options);
        args.push(device);
        break;
      default:
        command = "fsck";
        args = args.concat(options);
        args.push(device);
        args.push("--");
        args = args.concat(fsoptions);
        break;
    }

    try {
      result = await filesystem.exec(command, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * mkdir [<options>] <path>
   *
   * @param {*} path
   * @param {*} options
   */
  async mkdir(path, options = []) {
    const filesystem = this;
    let args = [];
    args = args.concat(options);
    args.push(path);

    try {
      await filesystem.exec("mkdir", args);
    } catch (err) {
      throw err;
    }
    return true;
  }

  /**
   * rmdir [<options>] <path>
   *
   * @param {*} path
   * @param {*} options
   */
  async rmdir(path, options = []) {
    const filesystem = this;
    let args = [];
    args = args.concat(options);
    args.push(path);

    try {
      await filesystem.exec("rmdir", args);
    } catch (err) {
      throw err;
    }
    return true;
  }

  /**
   *
   * @param {*} path
   */
  async pathExists(path) {
    const filesystem = this;
    let args = [];
    args.push(path);

    try {
      await filesystem.exec("stat", args);
    } catch (err) {
      return false;
    }
    return true;
  }

  exec(command, args, options) {
    const filesystem = this;
    args = args || [];

    let timeout;
    let stdout = "";
    let stderr = "";

    if (filesystem.options.sudo) {
      args.unshift(command);
      command = filesystem.options.paths.sudo;
    }
    console.log("executing filesystem command: %s %s", command, args.join(" "));
    const child = filesystem.options.executor.spawn(command, args, options);

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
        const result = { code, stdout, stderr, timeout: false };
        if (timeout) {
          clearTimeout(timeout);
        }

        if (code === null) {
          result.timeout = true;
          reject(result);
        }

        if (code) {
          console.log(
            "failed to execute filesystem command: %s, response: %j",
            [command].concat(args).join(" "),
            result
          );
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }
}

module.exports.Filesystem = Filesystem;
