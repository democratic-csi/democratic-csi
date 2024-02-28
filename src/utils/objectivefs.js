const cp = require("child_process");

const DEFAULT_TIMEOUT = process.env.MOUNT_DEFAULT_TIMEOUT || 30000;

const EXIT_CODE_64 = "administrator can not mount filesystems";
const EXIT_CODE_78 = "missing or invalid passphrase";

/**
 * https://objectivefs.com/
 */
class ObjectiveFS {
  constructor(options = {}) {
    const objectivefs = this;
    objectivefs.options = options;

    options.paths = options.paths || {};
    if (!options.paths.objectivefs) {
      options.paths.objectivefs = "mount.objectivefs";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.paths.chroot) {
      options.paths.chroot = "/usr/sbin/chroot";
    }

    if (!options.env) {
      options.env = {};
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
        //spawn: cp.execFile,
      };
    }
  }

  /**
   * mount.objectivefs [-o <opt>[,<opt>]..] <filesystem> <dir>
   *
   * @param {*} env
   * @param {*} filesystem
   * @param {*} target
   * @param {*} options
   */
  async mount(env, filesystem, target, options = []) {
    if (!env) {
      env = {};
    }
    const objectivefs = this;
    let args = [];
    if (options.length > 0) {
      // TODO: maybe do -o <opt> -o <opt>?
      args = args.concat(["-o", options.join(",")]);
    }
    args = args.concat([filesystem, target]);

    let result;
    try {
      result = await objectivefs.exec(
        objectivefs.options.paths.objectivefs,
        args,
        { env, operation: "mount" }
      );
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * mount.objectivefs create <your filesystem name>
   * mount.objectivefs create -f <bucket>/<fs>
   *
   * @param {*} env
   * @param {*} filesystem
   * @param {*} options
   */
  async create(env, filesystem, options = []) {
    if (!env) {
      env = {};
    }
    const objectivefs = this;
    let args = ["create"];
    args = args.concat(options);
    args = args.concat([filesystem]);

    let result;
    try {
      result = await objectivefs.exec(
        objectivefs.options.paths.objectivefs,
        args,
        { env }
      );
      return result;
    } catch (err) {
      if (err.code == 1 && err.stderr.includes("filesystem already exists")) {
        return;
      }
      throw err;
    }
  }

  /**
   * echo 'y' | mount.objectivefs destroy <bucket>/<fs>
   *
   * @param {*} env
   * @param {*} filesystem
   * @param {*} options
   */
  async destroy(env, filesystem, options = []) {
    if (!env) {
      env = {};
    }
    const objectivefs = this;
    let args = ["destroy"];
    args = args.concat(options);
    args = args.concat([filesystem]);

    let result;
    try {
      result = await objectivefs.exec(
        "/bin/bash",
        [
          "-c",
          `echo y | ${objectivefs.options.paths.objectivefs} ${args.join(" ")}`,
        ],
        { env }
      );

      return result;
    } catch (err) {
      if (
        err.code == 68 &&
        err.stdout.includes("does not look like an ObjectiveFS filesystem")
      ) {
        return;
      }
      throw err;
    }
  }

  parseListOutput(data) {
    const lines = data.split("\n");
    let headers = [];
    let entries = [];
    lines.forEach((line, i) => {
      if (line.length < 1) {
        return;
      }
      const parts = line.split("\t");
      if (i == 0) {
        headers = parts.map((header) => {
          return header.trim();
        });
        return;
      }

      let entry = {};
      headers.forEach((name, index) => {
        entry[name.trim()] = parts[index].trim();
      });

      entries.push(entry);
    });

    return entries;
  }

  /**
   * mount.objectivefs list [-asvz] [<filesystem>[@<time>]]
   *
   * @param {*} env
   * @param {*} filesystem
   * @param {*} options
   */
  async list(env, filesystem = null, options = []) {
    if (!env) {
      env = {};
    }
    const objectivefs = this;
    let args = ["list"];
    args = args.concat(options);
    if (filesystem) {
      args = args.concat([filesystem]);
    }

    let result;
    try {
      result = await objectivefs.exec(
        objectivefs.options.paths.objectivefs,
        args,
        { env }
      );

      return objectivefs.parseListOutput(result.stdout);
    } catch (err) {
      throw err;
    }
  }

  /**
   * mount.objectivefs snapshot <filesystem>
   *
   * NOTE: fs must be mount on node to function
   *
   * @param {*} env
   * @param {*} filesystem
   * @param {*} options
   */
  async snapshot(env, filesystem = null, options = []) {
    if (!env) {
      env = {};
    }
    const objectivefs = this;
    let args = ["list"];
    args = args.concat(options);
    if (filesystem) {
      args = args.concat([filesystem]);
    }

    let result;
    try {
      // NOTE: Successfully created snapshot: minio://ofs/test@2024-02-13T07:56:38Z (2024-02-13T00:56:38)
      result = await objectivefs.exec(
        objectivefs.options.paths.objectivefs,
        args,
        { env }
      );

      return result;
    } catch (err) {
      throw err;
    }
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const objectivefs = this;
    args = args || [];

    if (objectivefs.options.sudo) {
      args.unshift(command);
      command = objectivefs.options.paths.sudo;
    }

    // OBJECTIVEFS_ENV
    options.env = { ...{}, ...objectivefs.options.env, ...options.env };
    //console.log(options);

    // truncate admin key during mount operations
    if (options.operation == "mount") {
      delete options.operation;
      // standard license is 24
      // admin key is 8
      if (
        options.env.OBJECTIVEFS_LICENSE &&
        options.env.OBJECTIVEFS_LICENSE.length > 24
      ) {
        options.env.OBJECTIVEFS_LICENSE =
          options.env.OBJECTIVEFS_LICENSE.substr(0, 24);
      }
    }

    options.env.PATH = process.env.PATH;

    const cleansedLog = `${command} ${args.join(" ")}`;
    console.log("executing objectivefs command: %s", cleansedLog);

    return new Promise((resolve, reject) => {
      let stdin;
      if (options.stdin) {
        stdin = options.stdin;
        delete options.stdin;
      }
      const child = objectivefs.options.executor.spawn(command, args, options);
      if (stdin) {
        child.stdin.write(stdin);
      }

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", function (data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function (data) {
        stderr = stderr + data;
      });

      child.on("close", function (code) {
        if (code == 78 && !stderr) {
          stderr += EXIT_CODE_78;
        }

        if (code == 64 && !stderr) {
          stderr += EXIT_CODE_64;
        }

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

module.exports.ObjectiveFS = ObjectiveFS;
