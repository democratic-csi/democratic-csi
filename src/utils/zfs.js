const events = require("events");
const cp = require("child_process");

const escapeShell = function (cmd) {
  cmd = String(cmd);
  return '"' + cmd.replace(/(["$`\\])/g, "\\$1") + '"';
};

class Zetabyte {
  constructor(options = {}) {
    const zb = this;
    zb.options = options;

    options.paths = options.paths || {};
    if (!options.paths.zpool) {
      options.paths.zpool = "/sbin/zpool";
    }

    if (!options.paths.zfs) {
      options.paths.zfs = "/sbin/zfs";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.paths.chroot) {
      options.paths.chroot = "/usr/sbin/chroot";
    }

    if (!options.timeout) {
      options.timeout = 10 * 60 * 1000;
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }

    if (!options.logger) {
      options.logger = console;
    }

    if (!options.hasOwnProperty("log_commands")) {
      options.log_commands = false;
    }

    zb.DEFAULT_ZPOOL_LIST_PROPERTIES = [
      "name",
      "size",
      "allocated",
      "free",
      "cap",
      "health",
      "altroot",
    ];

    zb.DEFAULT_ZFS_LIST_PROPERTIES = [
      "name",
      "used",
      "avail",
      "refer",
      "type",
      "mountpoint",
    ];

    zb.helpers = {
      zfsErrorStr: function (error, stderr) {
        if (!error) return null;

        if (error.killed) return "Process killed due to timeout.";

        return error.message || (stderr ? stderr.toString() : "");
      },

      zfsError: function (error, stderr) {
        return new Error(zb.helpers.zfsErrorStr(error, stderr));
      },

      parseTabSeperatedTable: function (data) {
        if (!data) {
          return [];
        }

        const lines = data.trim().split("\n");
        const rows = [];

        for (let i = 0, numLines = lines.length; i < numLines; i++) {
          if (lines[i]) {
            rows.push(lines[i].split("\t"));
          }
        }

        return rows;
      },

      /*
       * Parse the output of `zfs get ...`, invoked by zfs.get below.  The output has
       * the form:
       *
       *     <dataset name>    <property name>    <property value>
       *
       * and those fields are tab-separated.
       */
      parsePropertyList: function (data) {
        if (!data) {
          return {};
        }

        const lines = data.trim().split("\n");
        const properties = {};

        lines.forEach(function (line) {
          const fields = line.split("\t");
          if (!properties[fields[0]]) properties[fields[0]] = {};
          properties[fields[0]][fields[1]] = {
            value: fields[2],
            received: fields[3],
            source: fields[4],
          };
        });

        return properties;
      },

      listTableToPropertyList: function (properties, data) {
        const entries = [];
        data.forEach((row) => {
          let entry = {};
          properties.forEach((value, index) => {
            entry[value] = row[index];
          });
          entries.push(entry);
        });

        return entries;
      },

      extractSnapshotName: function (datasetName) {
        return datasetName.substring(datasetName.indexOf("@") + 1);
      },

      extractDatasetName: function (datasetName) {
        if (datasetName.includes("@")) {
          return datasetName.substring(0, datasetName.indexOf("@"));
        }

        return datasetName;
      },

      isZfsSnapshot: function (snapshotName) {
        return snapshotName.includes("@");
      },

      extractPool: function (datasetName) {
        const parts = datasetName.split("/");
        return parts[0];
      },

      extractParentDatasetName: function (datasetName) {
        const parts = datasetName.split("/");
        parts.pop();
        return parts.join("/");
      },

      extractLeafName: function (datasetName) {
        return datasetName.split("/").pop();
      },

      isPropertyValueSet: function (value) {
        if (
          value === undefined ||
          value === null ||
          value == "" ||
          value == "-"
        ) {
          return false;
        }

        return true;
      },

      generateZvolSize: function (capacity_bytes, block_size) {
        block_size = "" + block_size;
        block_size = block_size.toLowerCase();
        switch (block_size) {
          case "512":
            block_size = 512;
            break;
          case "1024":
          case "1k":
            block_size = 1024;
            break;
          case "2048":
          case "2k":
            block_size = 2048;
            break;
          case "4096":
          case "4k":
            block_size = 4096;
            break;
          case "8192":
          case "8k":
            block_size = 8192;
            break;
          case "16384":
          case "16k":
            block_size = 16384;
            break;
          case "32768":
          case "32k":
            block_size = 32768;
            break;
          case "65536":
          case "64k":
            block_size = 65536;
            break;
          case "131072":
          case "128k":
            block_size = 131072;
            break;
        }

        capacity_bytes = Number(capacity_bytes);
        let result = block_size * Math.round(capacity_bytes / block_size);
        if (result < capacity_bytes)
          result = Number(result) + Number(block_size);

        return result;
      },
    };

    zb.zpool = {
      /**
       * zpool add [-fn] pool vdev ...
       *
       * @param {*} pool
       * @param {*} vdevs
       */
      add: function (callContext, pool, vdevs) {
        // -f force
        // -n noop
      },

      /**
       * zpool attach [-f] pool device new_device
       *
       * @param {*} pool
       * @param {*} device
       * @param {*} new_device
       */
      attach: function (callContext, pool, device, new_device) {
        // -f      Forces use of new_device, even if its appears to be in use.
      },

      /**
       * zpool checkpoint [-d, --discard] pool
       *
       * @param {*} pool
       */
      checkpoint: function (callContext, pool) {},

      /**
       * zpool clear [-F [-n]] pool [device]
       *
       * @param {*} pool
       * @param {*} device
       */
      clear: function (callContext, pool, device) {},

      /**
       * zpool create [-fnd] [-o property=value] ... [-O
       *  file-system-property=value] ... [-m mountpoint] [-R root] [-t
       *  tempname] pool vdev ...
       *
       * This allows fine-grained control and exposes all features of the
       * zpool create command, including log devices, cache devices, and hot spares.
       * The input is an object of the form produced by the disklayout library.
       */
      create: function (callContext, pool, options) {
        if (arguments.length != 3)
          throw Error("Invalid arguments, 2 arguments required");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("create");

          if (options.force) args.push("-f");
          if (options.noop) args.push("-n");
          if (options.disableFeatures) args.push("-d");
          if (options.properties) {
            for (const [key, value] of Object.entries(options.properties)) {
              args.push("-o");
              args.push(`${key}=${value}`);
            }
          }
          if (options.fsProperties) {
            for (let [key, value] of Object.entries(options.fsProperties)) {
              value = escapeShell(value);
              args.push("-O");
              args.push(`${key}=${value}`);
            }
          }
          if (options.mountpoint)
            args = args.concat(["-m", options.mountpoint]);
          if (options.root) args = args.concat(["-R", options.root]);
          if (options.tempname) args = args.concat(["-t", options.tempname]);

          args.push(pool);
          options.vdevs.forEach(function (vdev) {
            if (vdev.type) args.push(vdev.type);
            if (vdev.devices) {
              vdev.devices.forEach(function (dev) {
                args.push(dev.name);
              });
            } else {
              args.push(vdev.name);
            }
          });

          if (options.spares) {
            args.push("spare");
            options.spares.forEach(function (dev) {
              args.push(dev.name);
            });
          }

          if (options.logs) {
            args.push("log");
            options.logs.forEach(function (dev) {
              args.push(dev.name);
            });
          }

          if (options.cache) {
            args.push("cache");
            options.cache.forEach(function (dev) {
              args.push(dev.name);
            });
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool destroy [-f] pool
       *
       * @param {*} pool
       */
      destroy: function (callContext, pool) {
        if (arguments.length != 2) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("destroy");
          if (options.force) args.push("-f");
          args.push(pool);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool detach pool device
       *
       * @param {*} pool
       * @param {*} device
       */
      detach: function (callContext, pool, device) {
        if (arguments.length != 3) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("detach");
          args.push(pool);
          args.push(device);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool export [-f] pool ...
       *
       * @param {*} pool
       */
      export: function (callContext, pool) {
        if (arguments.length != 2) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("export");
          if (options.force) args.push("-f");
          if (Array.isArray(pool)) {
            pool.forEach((item) => {
              args.push(item);
            });
          } else {
            args.push(pool);
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool get [-Hp] [-o field[,...]] all | property[,...] pool ...
       */
      get: function (callContext) {},

      /**
       * zpool history [-il] [pool] ...
       *
       * @param {*} pool
       */
      history: function (callContext, pool) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("history");
          if (options.internal) args.push("-i");
          if (options.longFormat) args.push("-l");
          if (Array.isArray(pool)) {
            pool.forEach((item) => {
              args.push(item);
            });
          } else {
            args.push(pool);
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool import [-d dir | -c cachefile] [-D]
       *
       * zpool import [-o mntopts] [-o property=value] ... [-d dir | -c cachefile]
       *  [-D] [-f] [-m] [-N] [-R root] [-F [-n]] -a
       *
       * zpool import [-o mntopts] [-o property=value] ... [-d dir | -c cachefile]
       *  [-D] [-f] [-m] [-N] [-R root] [-t] [-F [-n]] pool | id [newpool]
       *
       *
       *
       * @param {*} options
       */
      import: function (callContext, options = {}) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("import");
          if (options.dir) args = args.concat(["-d", options.dir]);
          if (options.cachefile) args = args.concat(["-c", options.cachefile]);
          if (options.destroyed) args.push("-D");

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool iostat [-T d|u] [-v] [pool] ... [interval [count]]
       *
       * @param {*} options
       */
      iostat: function (callContext, options = {}) {},

      /**
       * zpool labelclear [-f] device
       *
       * @param {*} device
       */
      labelclear: function (callContext, device) {},

      /**
       * zpool list [-Hpv] [-o property[,...]] [-T d|u] [pool] ... [inverval
       *  [count]]
       *
       * @param {*} pool
       * @param {*} options
       */
      list: function (callContext, pool, properties, options = {}) {
        if (!(arguments.length >= 2)) throw Error("Invalid arguments");
        if (!properties) properties = zb.DEFAULT_ZPOOL_LIST_PROPERTIES;

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("list");
          if (!("parse" in options)) options.parse = true;
          if (!("parseable" in options)) options.parsable = true;
          if (options.parseable || options.parse) args.push("-Hp");
          if (options.verbose) args.push("-v");
          if (properties) {
            if (Array.isArray(properties)) {
              if (properties.length == 0) {
                properties = zb.DEFAULT_ZPOOL_LIST_PROPERTIES;
              }
              args.push("-o");
              args.push(properties.join(","));
            } else {
              args.push("-o");
              args.push(properties);
            }
          }
          if (options.timestamp) args = args.concat(["-T", options.timestamp]);
          if (pool) {
            if (Array.isArray(pool)) {
              pool.forEach((item) => {
                args.push(item);
              });
            } else {
              args.push(pool);
            }
          }
          if (options.interval) args.push(options.interval);
          if (options.count) args.push(options.count);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              if (options.parse) {
                let data = zb.helpers.parseTabSeperatedTable(stdout);
                let indexed = zb.helpers.listTableToPropertyList(
                  properties,
                  data
                );
                return resolve({
                  properties,
                  data,
                  indexed,
                });
              }
              return resolve({ properties, data: stdout });
            }
          );
        });
      },

      /**
       * zpool offline [-t] pool device ...
       *
       * @param {*} pool
       * @param {*} device
       * @param {*} options
       */
      offline: function (callContext, pool, device, options = {}) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("offline");
          if (options.temporary) args.push("-t");
          args.push(pool);
          args.push(device);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool online [-e] pool device ...
       *
       * @param {*} pool
       * @param {*} device
       * @param {*} options
       */
      online: function (callContext, pool, device, options = {}) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("online");
          if (options.expand) args.push("-e");
          args.push(pool);
          args.push(device);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool reguid pool
       *
       * @param {*} pool
       */
      reguid: function (callContext, pool) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("reguid");
          args.push(pool);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool remove [-np] pool device ...
       *
       * zpool remove -s pool
       *
       * @param {*} pool
       * @param {*} device
       */
      remove: function (callContext, pool, device, options = {}) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("remove");
          if (options.noop) args.push("-n");
          if (options.parsable) args.push("-p");
          if (options.stop) args.push("-s");
          args.push(pool);
          if (device) {
            args.push(device);
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool reopen pool
       *
       * @param {*} pool
       */
      reopen: function (callContext, pool) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("reopen");
          args.push(pool);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool replace [-f] pool device [new_device]
       *
       * @param {*} pool
       * @param {*} device
       * @param {*} new_device
       */
      replace: function (callContext, pool, device, new_device) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("replace");
          if (options.force) args.push("-f");
          args.push(pool);
          args.push(device);
          if (new_device) {
            args.push(new_device);
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool scrub [-s | -p] pool ...
       *
       * @param {*} pool
       */
      scrub: function (callContext, pool) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("scrub");
          if (options.stop) args.push("-s");
          if (options.pause) args.push("-p");
          if (Array.isArray(pool)) {
            pool.forEach((item) => {
              args.push(item);
            });
          } else {
            args.push(pool);
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool set property=value pool
       *
       * @param {*} pool
       * @param {*} property
       * @param {*} value
       */
      set: function (callContext, pool, property, value) {
        value = escapeShell(value);
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("set");
          args.push(`${property}=${value}`);
          args.push(pool);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zpool split [-n] [-R altroot] [-o mntopts] [-o property=value] pool
       *  newpool [device ...]
       *
       * @param {*} pool
       * @param {*} newpool
       * @param {*} device
       */
      split: function (callContext, pool, newpool, device) {},

      /**
       * zpool status [-vx] [-T d|u] [pool] ... [interval [count]]
       */
      status: function (callContext, pool, options = {}) {
        return new Promise((resolve, reject) => {
          let args = [];
          if (!("parse" in options)) options.parse = true;
          args.push("status");
          if (options.verbose) args.push("-v");
          if (options.exhibiting) args.push("-x");
          if (options.timestamp) args = args.concat(["-T", options.timestamp]);
          if (pool) {
            if (Array.isArray(pool)) {
              pool.forEach((item) => {
                args.push(item);
              });
            } else {
              args.push(pool);
            }
          }
          if (options.interval) args.push(options.interval);
          if (options.count) args.push(options.count);

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (options.parse) {
                stdout = stdout.trim();
                if (error || stdout == "no pools available\n") {
                  return resolve("UNKNOWN");
                }

                const lines = stdout.split("\n");
                for (var i = 0; i < lines.length; i++) {
                  if (lines[i].trim().substr(0, 5) === "state") {
                    return resolve(lines[i].trim().substr(7));
                  }
                }
                return resolve("UNKNOWN");
              } else {
                if (error) return reject(stderr);
                return resolve(stdout);
              }
            }
          );
        });
      },

      /**
       * zpool upgrade [-v]
       *
       * zpool upgrade [-V version] -a | pool ...
       *
       * @param {*} pool
       */
      upgrade: function (callContext, pool) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("upgrade");
          if (options.version) args = args.concat(["-V", options.version]);
          if (options.all) args.push("-a");
          if (pool) {
            if (Array.isArray(pool)) {
              pool.forEach((item) => {
                args.push(item);
              });
            } else {
              args.push(pool);
            }
          }

          zb.exec(
            zb.options.paths.zpool,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(stderr);
              return resolve(stdout);
            }
          );
        });
      },
    };

    zb.zfs = {
      /**
       * zfs create [-pu] [-o property=value]... filesystem
       * zfs create [-ps] [-b blocksize] [-o property=value]... -V size volume
       *
       * @param {*} dataset
       * @param {*} options
       */
      create: function (callContext, dataset, options = {}) {
        if (!(arguments.length >= 2)) throw new (Error("Invalid arguments"))();

        return new Promise((resolve, reject) => {
          const idempotent =
            "idempotent" in options
              ? options.idempotent
              : "idempotent" in zb.options
              ? zb.options.idempotent
              : false;

          let args = [];
          args.push("create");
          if (options.parents) args.push("-p");
          if (options.unmounted) args.push("-u");
          if (options.blocksize) args = args.concat(["-b", options.blocksize]);
          if (options.properties) {
            for (let [key, value] of Object.entries(options.properties)) {
              value = escapeShell(value);
              args.push("-o");
              args.push(`${key}=${value}`);
            }
          }
          if (options.size) args = args.concat(["-V", options.size]);
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (
                error &&
                !(idempotent && stderr.includes("dataset already exists"))
              )
                return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs destroy [-fnpRrv] filesystem|volume
       * zfs destroy [-dnpRrv] snapshot[%snapname][,...]
       * zfs destroy filesystem|volume#bookmark
       *
       *
       * @param {*} dataset
       * @param {*} options
       */
      destroy: function (callContext, dataset, options = {}) {
        if (!(arguments.length >= 2)) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          const idempotent =
            "idempotent" in options
              ? options.idempotent
              : "idempotent" in zb.options
              ? zb.options.idempotent
              : false;

          let args = [];
          args.push("destroy");
          if (!("parseable" in options)) options.parseable = true;
          if (options.recurse) args.push("-r");
          if (options.dependents) args.push("-R");
          if (options.force) args.push("-f");
          if (options.noop) args.push("-n");
          if (options.parseable) args.push("-p");
          if (options.verbose) args.push("-v");
          if (options.defer) args.push("-d");
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (
                error &&
                !(
                  idempotent &&
                  (stderr.includes("dataset does not exist") ||
                    stderr.includes("could not find any snapshots to destroy"))
                )
              )
                return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs snapshot|snap [-r] [-o property=value]...
       *  filesystem@snapname|volume@snapname
       *  filesystem@snapname|volume@snapname...
       *
       * @param {*} dataset
       * @param {*} options
       */
      snapshot: function (callContext, dataset, options = {}) {
        if (!(arguments.length >= 2)) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          const idempotent =
            "idempotent" in options
              ? options.idempotent
              : "idempotent" in zb.options
              ? zb.options.idempotent
              : false;

          let args = [];
          args.push("snapshot");
          if (options.recurse) args.push("-r");
          if (options.properties) {
            for (let [key, value] of Object.entries(options.properties)) {
              value = escapeShell(value);
              args.push("-o");
              args.push(`${key}=${value}`);
            }
          }
          if (Array.isArray(dataset)) {
            dataset = dataset.join(" ");
          }
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (
                error &&
                !(idempotent && stderr.includes("dataset already exists"))
              )
                return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs rollback [-rRf] snapshot
       *
       * @param {*} dataset
       * @param {*} options
       */
      rollback: function (callContext, dataset, options = {}) {
        if (!(arguments.length >= 2)) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("rollback");
          if (options.recent) args.push("-r");
          if (options.dependents) args.push("-R");
          if (options.force) args.push("-f");
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              /**
               * cannot rollback to 'foo/bar/baz@foobar': more recent snapshots or bookmarks exist
               * use '-r' to force deletion of the following snapshots and bookmarks:
               */
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs clone [-p] [-o property=value]... snapshot filesystem|volume
       *
       * @param {*} snapshot
       * @param {*} dataset
       * @param {*} options
       */
      clone: function (callContext, snapshot, dataset, options = {}) {
        if (!(arguments.length >= 3)) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          const idempotent =
            "idempotent" in options
              ? options.idempotent
              : "idempotent" in zb.options
              ? zb.options.idempotent
              : false;

          let args = [];
          args.push("clone");
          if (options.parents) args.push("-p");
          if (options.properties) {
            for (let [key, value] of Object.entries(options.properties)) {
              value = escapeShell(value);
              args.push("-o");
              args.push(`${key}=${value}`);
            }
          }
          args.push(snapshot);
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (
                error &&
                !(idempotent && stderr.includes("dataset already exists"))
              )
                return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * /bin/sh -c "zfs send [<send_options>] <source> | zfs receive [<receive_options>] <target>
       *
       * @param {*} source
       * @param {*} send_options
       * @param {*} target
       * @param {*} receive_options
       */
      send_receive(callContext, source, send_options = [], target, receive_options = []) {
        if (arguments.length < 5) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          // specially handle sudo here to avoid the need for using sudo on the whole script
          // but rather limit sudo access to only the zfs command
          let use_sudo = zb.options.sudo;
          let args = ["-c"];
          let command = [];
          if (use_sudo) {
            command = command.concat(zb.options.paths.sudo);
          }
          command = command.concat(["zfs", "send"]);
          command = command.concat(send_options);
          command.push(source);

          command.push("|");

          if (use_sudo) {
            command = command.concat(zb.options.paths.sudo);
          }
          command = command.concat(["zfs", "receive"]);
          command = command.concat(receive_options);
          command.push(target);

          args.push("'" + command.join(" ") + "'");

          zb.exec(
            "/bin/sh",
            args,
            { timeout: zb.options.timeout, sudo: false },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs promote clone-filesystem
       *
       * @param {*} dataset
       */
      promote: function (callContext, dataset) {
        if (arguments.length != 2) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("promote");
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs rename [-f] filesystem|volume|snapshot filesystem|volume|snapshot
       * zfs rename [-f] -p filesystem|volume filesystem|volume
       * zfs rename -u [-p] filesystem filesystem
       * zfs rename -r snapshot snapshot
       *
       * @param {*} source
       * @param {*} target
       * @param {*} options
       */
      rename: function (callContext, source, target, options = {}) {
        if (!(arguments.length >= 3)) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("rename");
          if (options.parents) args.push("-p");
          if (options.unmounted) args.push("-u");
          if (options.force) args.push("-f");
          if (options.recurse) args.push("-r");
          args.push(source);
          args.push(target);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs list [-r|-d depth] [-Hp] [-o property[,property]...] [-t
       *  type[,type]...] [-s property]... [-S property]...
       *  filesystem|volume|snapshot...
       *
       * @param {*} dataset
       * @param {*} properties
       * @param {*} options
       */
      list: function (callContext, dataset, properties, options = {}) {
        if (!(arguments.length >= 2)) throw Error("Invalid arguments");
        if (!properties) properties = zb.DEFAULT_ZFS_LIST_PROPERTIES;

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("list");
          if (!("parse" in options)) options.parse = true;
          if (!("parseable" in options)) options.parsable = true;
          if (options.recurse) args.push("-r");
          if (options.depth) args = args.concat(["-d", options.depth]);
          if (options.parseable || options.parse) args.push("-Hp");
          if (options.types) {
            let types;
            if (Array.isArray(options.types)) {
              types = options.types.join(",");
            } else {
              types = options.types;
            }
            args = args.concat(["-t", types]);
          }

          if (properties) {
            if (Array.isArray(properties)) {
              if (properties.length == 0) {
                properties = zb.DEFAULT_ZFS_LIST_PROPERTIES;
              }
              args.push("-o");
              args.push(properties.join(","));
            } else {
              args.push("-o");
              args.push(properties);
            }
          }
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              if (options.parse) {
                let data = zb.helpers.parseTabSeperatedTable(stdout);
                let indexed = zb.helpers.listTableToPropertyList(
                  properties,
                  data
                );
                return resolve({
                  properties,
                  data,
                  indexed,
                });
              }
              return resolve({ properties, data: stdout });
            }
          );
        });
      },

      /**
       * zfs set property=value [property=value]... filesystem|volume|snapshot
       *
       * @param {*} dataset
       * @param {*} properties
       */
      set: function (callContext, dataset, properties) {
        if (arguments.length != 3) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          if (!Object.keys(properties).length) {
            resolve();
            return;
          }

          let args = [];
          args.push("set");

          if (properties) {
            for (let [key, value] of Object.entries(properties)) {
              value = escapeShell(value);
              args.push(`${key}=${value}`);
            }
          }
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs get [-r|-d depth] [-Hp] [-o all | field[,field]...] [-t
       *  type[,type]...] [-s source[,source]...] all | property[,property]...
       *  filesystem|volume|snapshot|bookmark...
       *
       * -o options: name,property,value,received,source - default name,property,value,source
       * -t options: filesystem, snapshot, volume - default all
       * -s options: local,default,inherited,temporary,received,none - default all
       *
       * @param {*} dataset
       * @param {*} properties
       */
      get: function (callContext, dataset, properties = "all", options = {}) {
        if (!(arguments.length >= 3)) throw Error("Invalid arguments");
        if (!properties) properties = "all";
        if (Array.isArray(properties) && !properties.length > 0)
          properties = "all";

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("get");
          if (!("parse" in options)) options.parse = true;
          if (!("parseable" in options)) options.parsable = true;
          if (options.recurse) args.push("-r");
          if (options.depth) args.concat(["-d", options.depth]);
          if (options.parseable || options.parse) args.push("-Hp");
          if (options.parse)
            args = args.concat([
              "-o",
              ["name", "property", "value", "received", "source"],
            ]);
          if (options.fields && !options.parse) {
            let fields;
            if (Array.isArray(options.fields)) {
              fields = options.fields.join(",");
            } else {
              fields = options.fields;
            }

            args = args.concat(["-o", fields]);
          }
          if (options.types) {
            let types;
            if (Array.isArray(options.types)) {
              types = options.types.join(",");
            } else {
              types = options.types;
            }
            args = args.concat(["-t", types]);
          }
          if (options.sources) {
            let sources;
            if (Array.isArray(options.sources)) {
              sources = options.sources.join(",");
            } else {
              sources = options.sources;
            }
            args = args.concat(["-s", sources]);
          }

          if (properties) {
            if (Array.isArray(properties)) {
              if (properties.length > 0) {
                args.push(properties.join(","));
              } else {
                args.push("all");
              }
            } else {
              args.push(properties);
            }
          } else {
            args.push("all");
          }
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              if (options.parse) {
                return resolve(zb.helpers.parsePropertyList(stdout));
              }
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs inherit [-rS] property filesystem|volume|snapshot...
       *
       * @param {*} dataset
       * @param {*} property
       */
      inherit: function (callContext, dataset, property) {
        if (arguments.length != 3) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("inherit");
          if (options.recurse) args.push("-r");
          if (options.received) args.push("-S");
          args.push(property);
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs remap filesystem|volume
       *
       * @param {*} dataset
       */
      remap: function (callContext, dataset) {
        if (arguments.length != 2) throw Error("Invalid arguments");

        return new Promise((resolve, reject) => {
          let args = [];
          args.push("remap");
          args.push(dataset);

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },

      /**
       * zfs upgrade [-v]
       * zfs upgrade [-r] [-V version] -a | filesystem
       *
       * @param {*} dataset
       */
      upgrade: function (callContext, options = {}, dataset) {
        return new Promise((resolve, reject) => {
          let args = [];
          args.push("upgrade");
          if (options.versions) args.push("-v");
          if (options.recurse) args.push("-r");
          if (options.version) args = args.concat(["-V", options.version]);
          if (options.all) args = args.push("-a");
          if (dataset) {
            args.push(dataset);
          }

          zb.exec(
            zb.options.paths.zfs,
            args,
            { timeout: zb.options.timeout },
            function (error, stdout, stderr) {
              if (error) return reject(zb.helpers.zfsError(error, stderr));
              return resolve(stdout);
            }
          );
        });
      },
    };
  }

  /**
   * Should be a matching interface for spawn roughly
   *
   */
  exec() {
    const zb = this;
    let command = arguments[0];
    let args, options, callback, timeout;
    let stdout = "";
    let stderr = "";
    switch (arguments.length) {
      case 1:
        break;
      case 2:
        callback = arguments[arguments.length - 1];
        break;
      case 3:
        callback = arguments[arguments.length - 1];
        args = arguments[arguments.length - 2];
        break;
      case 4:
        callback = arguments[arguments.length - 1];
        options = arguments[arguments.length - 2];
        args = arguments[arguments.length - 3];
        break;
    }

    if (zb.options.chroot) {
      args = args || [];
      args.unshift(command);
      args.unshift(zb.options.chroot);
      command = zb.options.paths.chroot;
    }

    let use_sudo = zb.options.sudo;
    if (options && options.hasOwnProperty("sudo")) {
      use_sudo = options.sudo;
    }

    if (use_sudo) {
      args = args || [];
      args.unshift(command);
      command = zb.options.paths.sudo;
    }

    if (zb.options.log_commands) {
      if (typeof zb.options.logger.verbose != "function") {
        zb.options.logger.verbose = function () {
          console.debug(...arguments);
        };
      }
      zb.options.logger.verbose(
        `executing zfs command: ${command} ${args.join(" ")}`
      );
    }

    const child = zb.options.executor.spawn(command, args, options);

    let didTimeout = false;
    if (options && options.timeout) {
      timeout = setTimeout(() => {
        didTimeout = true;
        child.kill(options.killSignal || "SIGTERM");
      }, options.timeout);
    }

    if (callback) {
      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (error) {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (error) {
          if (didTimeout) {
            error.killed = true;
          }
          callback(zb.helpers.zfsError(error, stderr), stdout, stderr);
        }
        callback(null, stdout, stderr);
      });
    }

    return child;
  }
}
exports.Zetabyte = Zetabyte;

class ZfsSshProcessManager {
  constructor(client) {
    this.client = client;
  }

  /**
   * Build a command line from the name and given args
   * TODO: escape the arguments
   *
   * @param {*} name
   * @param {*} args
   */
  buildCommand(name, args = []) {
    args.unshift(name);
    return args.join(" ");
  }

  /**
   * https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
   *
   * should return something similar to a child_process that handles the following:
   *  - child.stdout.on('data')
   *  - child.stderr.on('data')
   *  - child.on('close')
   *  - child.kill()
   */
  spawn() {
    const client = this.client;

    //client.debug("ZfsProcessManager spawn", this);

    // Create an eventEmitter object
    var stdout = new events.EventEmitter();
    var stderr = new events.EventEmitter();
    var proxy = new events.EventEmitter();

    proxy.stdout = stdout;
    proxy.stderr = stderr;
    proxy.kill = function (signal = "SIGTERM") {
      proxy.emit("kill", signal);
    };

    const command = this.buildCommand(arguments[0], arguments[1]);

    client.debug("ZfsProcessManager arguments: " + JSON.stringify(arguments));
    client.logger.verbose("ZfsProcessManager command: " + command);

    client.exec(command, {}, proxy).catch((err) => {
      proxy.stderr.emit("data", err.message);
      proxy.emit("close", 1, "SIGQUIT");
    });

    return proxy;
  }
}
exports.ZfsSshProcessManager = ZfsSshProcessManager;
