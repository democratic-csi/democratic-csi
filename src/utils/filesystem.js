const cp = require("child_process");
const fs = require("fs");
const GeneralUtils = require("./general");
const path = require("path");

const DEFAULT_TIMEOUT = process.env.FILESYSTEM_DEFAULT_TIMEOUT || 30000;

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

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }
  }

  covertUnixSeparatorToWindowsSeparator(p) {
    return p.replaceAll(path.posix.sep, path.win32.sep);
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

  async isSymbolicLink(path) {
    return fs.lstatSync(path).isSymbolicLink();
  }

  /**
   * remove file
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
    let args = ["-a", "-b", "-J", "-O"];
    args.push(device);
    let result;

    try {
      result = await filesystem.exec("lsblk", args);
      const parsed = JSON.parse(result.stdout);
      if (parsed.blockdevices.length != 1) {
        throw new Error(`cannot properly find device: ${device}`);
      }
      return parsed.blockdevices[0];
    } catch (err) {
      throw err;
    }
  }

  /**
   *
   * @param {*} device
   * @returns
   */
  async getBlockDeviceLargestPartition(device) {
    const filesystem = this;
    let block_device_info = await filesystem.getBlockDevice(device);
    if (block_device_info.children) {
      let child;
      for (const child_i of block_device_info.children) {
        if (child_i.type == "part") {
          if (!child) {
            child = child_i;
          } else {
            if (child_i.size > child.size) {
              child = child_i;
            }
          }
        }
      }
      return `${child.path}`;
    }
  }

  /**
   *
   * @param {*} device
   * @returns
   */
  async getBlockDeviceLastPartition(device) {
    const filesystem = this;
    let block_device_info = await filesystem.getBlockDevice(device);
    if (block_device_info.children) {
      let child;
      for (const child_i of block_device_info.children) {
        if (child_i.type == "part") {
          if (!child) {
            child = child_i;
          } else {
            let minor = child["maj:min"].split(":")[1];
            let minor_i = child_i["maj:min"].split(":")[1];
            if (minor_i > minor) {
              child = child_i;
            }
          }
        }
      }
      return `${child.path}`;
    }
  }

  /**
   *
   * @param {*} device
   * @returns
   */
  async getBlockDevicePartitionCount(device) {
    const filesystem = this;
    let count = 0;
    let block_device_info = await filesystem.getBlockDevice(device);
    if (block_device_info.children) {
      for (const child_i of block_device_info.children) {
        if (child_i.type == "part") {
          count++;
        }
      }
    }
    return count;
  }

  async getBlockDeviceHasParitionTable(device) {
    const filesystem = this;
    let block_device_info = await filesystem.getBlockDevice(device);

    return block_device_info.pttype ? true : false;
  }

  /**
   * DOS
   * - type=83 = Linux
   * - type=07 = HPFS/NTFS/exFAT
   *
   * GPT
   * - type=0FC63DAF-8483-4772-8E79-3D69D8477DE4 = linux
   * - type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7 = ntfs
   * - type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B = EFI
   *
   * @param {*} device
   * @param {*} label
   * @param {*} type
   */
  async partitionDevice(
    device,
    label = "gpt",
    type = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"
  ) {
    const filesystem = this;
    let args = [device];
    let result;

    try {
      result = await filesystem.exec("sfdisk", args, {
        stdin: `label: ${label}\n`,
      });
      result = await filesystem.exec("sfdisk", args, {
        stdin: `type=${type}\n`,
      });
    } catch (err) {
      throw err;
    }
  }

  /**
   * mimic the behavior of partitioning a new data drive in windows directly
   *
   * https://en.wikipedia.org/wiki/Microsoft_Reserved_Partition
   *
   * @param {*} device
   */
  async partitionDeviceWindows(device) {
    const filesystem = this;
    let args = [device];
    let result;
    let block_device_info = await filesystem.getBlockDevice(device);

    //let sixteen_megabytes = 16777216;
    //let thirtytwo_megabytes = 33554432;
    //let onehundredtwentyeight_megabytes = 134217728;

    let msr_partition_size = "16M";
    let label = "gpt";
    let msr_guid = "E3C9E316-0B5C-4DB8-817D-F92DF00215AE";
    let ntfs_guid = "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7";

    if (block_device_info.type != "disk") {
      throw new Error(
        `cannot partition device of type: ${block_device_info.type}`
      );
    }

    /**
     * On drives less than 16GB in size, the MSR is 32MB.
     * On drives greater than or equal two 16GB, the MSR is 128 MB.
     * It is only 128 MB for Win 7/8 ( On drives less than 16GB in size, the MSR is 32MB ) & 16 MB for win 10!
     */
    let msr_partition_size_break = 17179869184; // 16GB

    // TODO: this size may be sectors so not really disk size in terms of GB
    if (block_device_info.size >= msr_partition_size_break) {
      // ignoring for now, appears windows 10+ use 16MB always
      //msr_partition_size = "128M";
    }

    try {
      result = await filesystem.exec("sfdisk", args, {
        stdin: `label: ${label}\n`,
      });
      // must send ALL partitions at once (newline separated), cannot send them 1 at a time
      result = await filesystem.exec("sfdisk", args, {
        stdin: `size=${msr_partition_size},type=${msr_guid}\ntype=${ntfs_guid}\n`,
      });
    } catch (err) {
      throw err;
    }
  }

  /**
   *
   * @param {*} device
   */
  async deviceIsFormatted(device) {
    const filesystem = this;
    let result;

    try {
      /**
       * lsblk
       * blkid
       */
      const strategy =
        process.env.FILESYSTEM_TYPE_DETECTION_STRATEGY || "lsblk";

      switch (strategy) {
        // requires udev data to be present otherwise fstype property is always null but otherwise succeeds
        case "lsblk":
          result = await filesystem.getBlockDevice(device);
          return result.fstype ? true : false;
        // no requirement on udev data to be present
        case "blkid":
          try {
            result = await filesystem.getDeviceFilesystemInfo(device);
          } catch (err) {
            // if not formatted nor partitioned exits with 2
            if (err.code == 2) {
              return false;
            }
            throw err;
          }

          return result.type ? true : false;
        // file -s <device> could also be an option
        default:
          throw new Error(`unknown filesystem detection strategy: ${strategy}`);
      }
    } catch (err) {
      throw err;
    }
  }

  async deviceIsIscsi(device) {
    const filesystem = this;
    let result;

    do {
      if (result) {
        device = `/dev/${result.pkname}`;
      }
      result = await filesystem.getBlockDevice(device);
    } while (result.pkname);

    return result && result.tran == "iscsi";
  }

  async deviceIsNVMEoF(device) {
    const filesystem = this;
    let result;

    do {
      if (result) {
        device = `/dev/${result.pkname}`;
      }
      result = await filesystem.getBlockDevice(device);
    } while (result.pkname);

    // TODO: add further logic here to ensure the device is not a local pcie/etc device
    return result && result.tran == "nvme";
  }

  async getBlockDeviceParent(device) {
    const filesystem = this;
    let result;

    do {
      if (result) {
        device = `/dev/${result.pkname}`;
      }
      result = await filesystem.getBlockDevice(device);
    } while (result.pkname);

    return result;
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

      // node-local devices cannot be rescanned, so ignore
      if (await filesystem.pathExists(sys_file)) {
        console.log(`executing filesystem command: echo 1 > ${sys_file}`);
        fs.writeFileSync(sys_file, "1");
      }
    }
  }

  async expandPartition(device) {
    const filesystem = this;
    const command = "growpart";
    const args = [];

    let block_device_info = await filesystem.getBlockDevice(device);
    let device_fs_info = await filesystem.getDeviceFilesystemInfo(device);
    let growpart_partition = device_fs_info["part_entry_number"];
    let parent_block_device = await filesystem.getBlockDeviceParent(device);

    args.push(parent_block_device.path, growpart_partition);

    try {
      await filesystem.exec(command, args);
    } catch (err) {
      if (
        err.code == 1 &&
        err.stdout &&
        err.stdout.includes("could only be grown by")
      ) {
        return;
      }
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
      case "btrfs":
        command = "btrfs";
        //args = args.concat(options);
        args = args.concat(["filesystem", "resize", "max"]);
        args.push(device); // in this case should be a mounted path
        break;
      case "exfat":
        // https://github.com/exfatprogs/exfatprogs/issues/134
        return;
      case "ext4":
      case "ext3":
      case "ext4dev":
        command = "resize2fs";
        args = args.concat(options);
        args.push(device);
        break;
      case "ntfs":
        // must be unmounted
        command = "ntfsresize";
        await filesystem.exec(command, ["-c", device]);
        await filesystem.exec(command, ["-n", device]);
        args = args.concat("-P", "-f");
        args = args.concat(options);
        //args = args.concat(["-s", "max"]);
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
      // must clear the dirty bit after resize
      if (fstype.toLowerCase() == "ntfs") {
        await filesystem.exec("ntfsfix", ["-d", device]);
      }
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
      case "btrfs":
        command = "btrfs";
        args = args.concat(options);
        args.push("check");
        args.push(device);
        break;
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
      case "ntfs":
        /**
         * -b, --clear-bad-sectors Clear the bad sector list
         * -d, --clear-dirty       Clear the volume dirty flag
         */
        command = "ntfsfix";
        args.puuh("-d");
        args.push(device);
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

  async getInodeInfo(path) {
    const filesystem = this;
    let args = ["-i"];
    let result;

    args.push(path);

    try {
      result = await filesystem.exec("df", args);
      if (result.code == 0) {
        result = result.stdout.split("\n")[1].replace(/\s\s+/g, " ");
        let parts = result.split(" ");
        return {
          device: parts[0],
          mount_path: parts[5],
          inodes_total: parseInt(parts[1]),
          inodes_used: parseInt(parts[2]),
          inodes_free: parseInt(parts[3]),
        };
      }
    } catch (err) {
      throw err;
    }
  }

  /**
   *
   * @param {*} path
   */
  async pathExists(path) {
    let result = false;
    try {
      await GeneralUtils.retry(
        10,
        200,
        () => {
          fs.statSync(path);
        },
        {
          retryCondition: (err) => {
            if (err.code == "UNKNOWN") {
              return true;
            }
            return false;
          },
        }
      );
      result = true;
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    return result;
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      // TODO: cannot use this as fsck etc are too risky to kill
      //options.timeout = DEFAULT_TIMEOUT;
    }

    let stdin;
    if (options.stdin) {
      stdin = options.stdin;
      delete options.stdin;
    }

    const filesystem = this;
    args = args || [];

    if (filesystem.options.sudo) {
      args.unshift(command);
      command = filesystem.options.paths.sudo;
    }
    let command_log = `${command} ${args.join(" ")}`.trim();
    if (stdin) {
      command_log = `echo '${stdin}' | ${command_log}`
        .trim()
        .replace(/\n/, "\\n");
    }
    console.log("executing filesystem command: %s", command_log);

    return new Promise((resolve, reject) => {
      const child = filesystem.options.executor.spawn(command, args, options);
      let stdout = "";
      let stderr = "";

      child.on("spawn", function () {
        if (stdin) {
          child.stdin.setEncoding("utf-8");
          child.stdin.write(stdin);
          child.stdin.end();
        }
      });

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
