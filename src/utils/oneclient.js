const cp = require("child_process");

const DEFAULT_TIMEOUT = process.env.MOUNT_DEFAULT_TIMEOUT || 30000;

/**
 * - https://github.com/onedata/oneclient
 */
class OneClient {
  constructor(options = {}) {
    const oneclient = this;
    oneclient.options = options;

    options.paths = options.paths || {};
    if (!options.paths.oneclient) {
      options.paths.oneclient = "oneclient";
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
   * oneclient [options] <directory>
   *
   * @param {*} target
   * @param {*} options
   */
  async mount(target, options = []) {
    const oneclient = this;
    let args = [];
    args = args.concat(options);
    args = args.concat([target]);

    let result;
    try {
      result = await oneclient.exec(oneclient.options.paths.oneclient, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * oneclient -u <directory>
   *
   * @param {*} target
   */
  async umount(target) {
    const oneclient = this;
    let args = ["-u"];
    args.push(target);

    try {
      await oneclient.exec(oneclient.options.paths.oneclient, args);
    } catch (err) {
      throw err;
    }
    return true;
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const oneclient = this;
    args = args || [];

    let stdout = "";
    let stderr = "";

    if (oneclient.options.sudo) {
      args.unshift(command);
      command = oneclient.options.paths.sudo;
    }

    // replace -t <token> with -t redacted
    const regex = /(?<=\-t) (?:[^\s]+)/gi;
    const cleansedLog = `${command} ${args.join(" ")}`.replace(
      regex,
      " redacted"
    );

    console.log("executing oneclient command: %s", cleansedLog);
    const child = oneclient.options.executor.spawn(command, args, options);

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

module.exports.OneClient = OneClient;
