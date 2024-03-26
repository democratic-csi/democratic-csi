const _ = require("lodash");
const cp = require("child_process");

const DEFAULT_TIMEOUT = process.env.RESTIC_DEFAULT_TIMEOUT || 90000;

/**
 * https://restic.net/
 */
class Restic {
  constructor(options = {}) {
    const restic = this;
    restic.options = options;

    options.paths = options.paths || {};
    if (!options.paths.restic) {
      options.paths.restic = "restic";
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
      };
    }

    if (!options.logger) {
      options.logger = console;
    }

    if (!options.global_flags) {
      options.global_flags = [];
    }
  }

  /**
   * restic init
   *
   * @param {*} options
   */
  async init(options = []) {
    const restic = this;
    let args = ["init", "--json"];
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    try {
      await restic.exec(restic.options.paths.restic, args);
      return;
    } catch (err) {
      if (err.code == 1 && err.stderr.includes("already")) {
        return;
      }
      throw err;
    }
  }

  /**
   * restic unlock
   *
   * @param {*} options
   */
  async unlock(options = []) {
    const restic = this;
    let args = ["unlock", "--json"];
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    try {
      await restic.exec(restic.options.paths.restic, args);
      return;
    } catch (err) {
      throw err;
    }
  }

  /**
   * restic backup
   *
   * @param {*} path
   * @param {*} options
   */
  async backup(path, options = []) {
    const restic = this;
    let args = [];
    args = args.concat(["backup", "--json"]);
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);
    args = args.concat([path]);

    let result;
    try {
      result = await restic.exec(restic.options.paths.restic, args, {
        operation: "backup",
        timeout: 0,
      });
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * restic tag
   *
   * @param {*} options
   */
  async tag(options = []) {
    const restic = this;
    let args = [];
    args = args.concat(["tag", "--json"]);
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await restic.exec(restic.options.paths.restic, args, {
        operation: "tag",
      });
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * restic snapshots
   *
   * @param {*} options
   */
  async snapshots(options = []) {
    const restic = this;
    let args = [];
    args = args.concat(["snapshots", "--json", "--no-lock"]);
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    restic.parseTagsFromArgs(args);

    let result;
    try {
      result = await restic.exec(restic.options.paths.restic, args, {
        operation: "snapshots",
      });

      let snapshots = [];
      result.parsed.forEach((item) => {
        if (item.id) {
          snapshots.push(item);
        }

        if (item.snapshots) {
          snapshots.push(...item.snapshots);
        }
      });

      return snapshots;
    } catch (err) {
      throw err;
    }
  }

  /**
   * restic snapshots
   *
   * @param {*} options
   */
  async snapshot_exists(snapshot_id) {
    const restic = this;
    const snapshots = await restic.snapshots([snapshot_id]);
    return snapshots.length > 0;
  }

  /**
   * restic forget
   *
   * @param {*} options
   */
  async forget(options = []) {
    const restic = this;
    let args = [];
    args = args.concat(["forget", "--json"]);
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await restic.exec(restic.options.paths.restic, args, {
        operation: "forget",
      });

      return result.parsed;
    } catch (err) {
      if (err.code == 1 && err.stderr.includes("no such file or directory")) {
        return [];
      }
      throw err;
    }
  }

  /**
   * restic stats
   *
   * @param {*} options
   */
  async stats(options = []) {
    const restic = this;
    let args = [];
    args = args.concat(["stats", "--json", "--no-lock"]);
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await restic.exec(restic.options.paths.restic, args, {
        operation: "stats",
        timeout: 0, // can take a very long time to gather up details
      });

      return result.parsed;
    } catch (err) {
      throw err;
    }
  }

  /**
   * restic restore
   *
   * note that restore does not do any delete operations (ie: not like rsync --delete)
   *
   * @param {*} options
   */
  async restore(options = []) {
    const restic = this;
    let args = ["restore", "--json", "--no-lock"];
    args = args.concat(restic.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await restic.exec(restic.options.paths.restic, args, {
        operation: "restore",
        timeout: 0,
      });
      return result.parsed;
    } catch (err) {
      if (err.code == 1 && err.stderr.includes("Fatal:")) {
        const lines = err.stderr.split("\n").filter((item) => {
          return Boolean(String(item).trim());
        });
        const last_line = lines[lines.length - 1];
        const ingored_count = (err.stderr.match(/ignoring error/g) || [])
          .length;

        restic.options.logger.info(
          `restic ignored error count: ${ingored_count}`
        );
        restic.options.logger.info(`restic stderr last line: ${last_line}`);

        // if ignored count matches total count move on
        // "Fatal: There were 2484 errors"
        if (last_line.includes(String(ingored_count))) {
          return err;
        }
      }
      throw err;
    }
  }

  trimResultData(result, options = {}) {
    const trim_output_limt = options.max_entries || 50;
    // trim stdout/stderr/parsed lines to X number
    if (result.parsed && Array.isArray(result.parsed)) {
      result.parsed = result.parsed.slice(trim_output_limt * -1);
    }

    result.stderr = result.stderr
      .split("\n")
      .slice(trim_output_limt * -1)
      .join("\n");

    result.stdout = result.stdout
      .split("\n")
      .slice(trim_output_limt * -1)
      .join("\n");

    return result;
  }

  parseTagsFromArgs(args) {
    let tag_value_index;
    let tags = args.filter((value, index) => {
      if (String(value) == "--tag") {
        tag_value_index = index + 1;
      }
      return tag_value_index == index;
    });

    tags = tags
      .map((value) => {
        if (value.includes(",")) {
          return value.split(",");
        }
        return [value];
      })
      .flat();
    return tags;
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const restic = this;
    args = args || [];

    if (restic.options.sudo) {
      args.unshift(command);
      command = restic.options.paths.sudo;
    }

    options.env = {
      ...{},
      ...process.env,
      ...restic.options.env,
      ...options.env,
    };

    const cleansedLog = `${command} ${args.join(" ")}`;
    console.log("executing restic command: %s", cleansedLog);

    return new Promise((resolve, reject) => {
      let stdin;
      if (options.stdin) {
        stdin = options.stdin;
        delete options.stdin;
      }
      const child = restic.options.executor.spawn(command, args, options);
      if (stdin) {
        child.stdin.write(stdin);
      }

      let stdout = "";
      let stderr = "";
      let code_override;

      const log_progress_output = _.debounce(
        (data) => {
          let snapshot_id;
          let path;
          switch (options.operation) {
            case "backup":
              snapshot_id = `unknown_creating_new_snapshot_in_progress`;
              path = args[args.length - 1];
              break;
            case "restore":
              snapshot_id = args
                .find((value) => {
                  return String(value).includes(":");
                })
                .split(":")[0];

              let path_index;
              path = args.find((value, index) => {
                if (String(value) == "--target") {
                  path_index = index + 1;
                }
                return path_index == index;
              });
              break;
            default:
              return;
          }

          if (data.message_type == "status") {
            delete data.current_files;
            restic.options.logger.info(
              `restic ${options.operation} progress: snapshot_id=${snapshot_id}, path=${path}`,
              data
            );
          }

          if (data.message_type == "summary") {
            restic.options.logger.info(
              `restic ${options.operation} summary: snapshot_id=${snapshot_id}, path=${path}`,
              data
            );
          }
        },
        250,
        { leading: true, trailing: true, maxWait: 5000 }
      );

      child.stdout.on("data", function (data) {
        data = String(data);
        stdout += data;
        switch (options.operation) {
          case "backup":
          case "restore":
            try {
              let parsed = JSON.parse(data);
              log_progress_output(parsed);
            } catch (err) {}
            break;
        }
      });

      child.stderr.on("data", function (data) {
        data = String(data);
        stderr += data;
        if (
          ["forget", "snapshots"].includes(options.operation) &&
          stderr.includes("no such file or directory")
        ) {
          // short-circut the operation vs waiting for all the retries
          // https://github.com/restic/restic/pull/2515
          switch (options.operation) {
            case "forget":
              code_override = 1;
              break;
            case "snapshots":
              code_override = 0;
              break;
          }

          child.kill();
        }
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr, timeout: false };

        if (!result.parsed) {
          try {
            result.parsed = JSON.parse(result.stdout);
          } catch (err) {}
        }

        if (!result.parsed) {
          try {
            const lines = result.stdout.split("\n");
            const parsed = [];
            lines.forEach((line) => {
              if (!line) {
                return;
              }
              parsed.push(JSON.parse(line.trim()));
            });
            result.parsed = parsed;
          } catch (err) {}
        }

        /**
         * normalize array responses in scenarios where not enough came through
         * to add newlines
         */
        if (result.parsed && options.operation == "backup") {
          if (!Array.isArray(result.parsed)) {
            result.parsed = [result.parsed];
          }
        }

        if (code == null && code_override != null) {
          code = code_override;
        }

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

module.exports.Restic = Restic;
