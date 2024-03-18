const _ = require("lodash");
const cp = require("child_process");
const uuidv4 = require("uuid").v4;

const DEFAULT_TIMEOUT = process.env.KOPIA_DEFAULT_TIMEOUT || 90000;

/**
 * https://kopia.io/
 */
class Kopia {
  constructor(options = {}) {
    const kopia = this;
    kopia.options = options;
    kopia.client_intance_uuid = uuidv4();

    options.paths = options.paths || {};
    if (!options.paths.kopia) {
      options.paths.kopia = "kopia";
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

    options.env[
      "KOPIA_CONFIG_PATH"
    ] = `/tmp/kopia/${kopia.client_intance_uuid}/repository.config`;
    options.env["KOPIA_CHECK_FOR_UPDATES"] = "false";
    options.env[
      "KOPIA_CACHE_DIRECTORY"
    ] = `/tmp/kopia/${kopia.client_intance_uuid}/cache`;
    options.env[
      "KOPIA_LOG_DIR"
    ] = `/tmp/kopia/${kopia.client_intance_uuid}/log`;

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn,
      };
    }

    if (!options.logger) {
      options.logger = console;
    }

    options.logger.info(
      `kopia client instantiated with client_instance_uuid: ${kopia.client_intance_uuid}`
    );

    if (!options.global_flags) {
      options.global_flags = [];
    }
  }

  /**
   * kopia repository connect
   *
   * https://kopia.io/docs/reference/command-line/common/repository-connect-from-config/
   *
   * --override-hostname
   * --override-username
   *
   * @param {*} options
   */
  async repositoryConnect(options = []) {
    const kopia = this;
    let args = ["repository", "connect"];
    args = args.concat(kopia.options.global_flags);
    args = args.concat(options);

    try {
      await kopia.exec(kopia.options.paths.kopia, args);
      return;
    } catch (err) {
      throw err;
    }
  }

  /**
   * kopia repository status
   *
   * @param {*} options
   */
  async repositoryStatus(options = []) {
    const kopia = this;
    let args = ["repository", "status", "--json"];
    args = args.concat(kopia.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await kopia.exec(kopia.options.paths.kopia, args);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * kopia snapshot list
   *
   * @param {*} options
   */
  async snapshotList(options = []) {
    const kopia = this;
    let args = [];
    args = args.concat(["snapshot", "list", "--json"]);
    args = args.concat(kopia.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await kopia.exec(kopia.options.paths.kopia, args, {
        operation: "snapshot-list",
      });

      return result.parsed;
    } catch (err) {
      throw err;
    }
  }

  /**
   * kopia snapshot list
   *
   * @param {*} snapshot_id
   */
  async snapshotGet(snapshot_id) {
    const kopia = this;
    let args = [];
    args = args.concat(["snapshot", "list", "--json", "--all"]);
    args = args.concat(kopia.options.global_flags);

    let result;
    try {
      result = await kopia.exec(kopia.options.paths.kopia, args, {
        operation: "snapshot-list",
      });

      return result.parsed.find((item) => {
        return item.id == snapshot_id;
      });
    } catch (err) {
      throw err;
    }
  }

  /**
   * kopia snapshot create
   *
   * @param {*} options
   */
  async snapshotCreate(options = []) {
    const kopia = this;
    let args = [];
    args = args.concat(["snapshot", "create", "--json"]);
    args = args.concat(kopia.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await kopia.exec(kopia.options.paths.kopia, args, {
        operation: "snapshot-create",
      });

      return result.parsed;
    } catch (err) {
      throw err;
    }
  }

  /**
   * kopia snapshot delete <id>
   *
   * @param {*} options
   */
  async snapshotDelete(options = []) {
    const kopia = this;
    let args = [];
    args = args.concat(["snapshot", "delete", "--delete"]);
    args = args.concat(kopia.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await kopia.exec(kopia.options.paths.kopia, args, {
        operation: "snapshot-delete",
      });

      return result;
    } catch (err) {
      if (
        err.code == 1 &&
        (err.stderr.includes("no snapshots matched") ||
          err.stderr.includes("invalid content hash"))
      ) {
        return;
      }

      throw err;
    }
  }

  /**
   * kopia snapshot restore <snapshot_id[/sub/path]> /path/to/restore/to
   *
   * @param {*} options
   */
  async snapshotRestore(options = []) {
    const kopia = this;
    let args = [];
    args = args.concat(["snapshot", "restore"]);
    args = args.concat(kopia.options.global_flags);
    args = args.concat(options);

    let result;
    try {
      result = await kopia.exec(kopia.options.paths.kopia, args, {
        operation: "snapshot-restore",
      });

      return result;
    } catch (err) {
      if (
        err.code == 1 &&
        (err.stderr.includes("no snapshots matched") ||
          err.stderr.includes("invalid content hash"))
      ) {
        return;
      }

      throw err;
    }
  }

  exec(command, args, options = {}) {
    if (!options.hasOwnProperty("timeout")) {
      options.timeout = DEFAULT_TIMEOUT;
    }

    const kopia = this;
    args = args || [];

    if (kopia.options.sudo) {
      args.unshift(command);
      command = kopia.options.paths.sudo;
    }

    options.env = {
      ...{},
      ...process.env,
      ...kopia.options.env,
      ...options.env,
    };

    let tokenIndex = args.findIndex((value) => {
      return value.trim() == "--token";
    });
    let cleansedArgs = [...args];
    if (tokenIndex >= 0) {
      cleansedArgs[tokenIndex + 1] = "redacted";
    }

    const cleansedLog = `${command} ${cleansedArgs.join(" ")}`;
    console.log("executing kopia command: %s", cleansedLog);

    return new Promise((resolve, reject) => {
      let stdin;
      if (options.stdin) {
        stdin = options.stdin;
        delete options.stdin;
      }
      const child = kopia.options.executor.spawn(command, args, options);
      if (stdin) {
        child.stdin.write(stdin);
      }

      let stdout = "";
      let stderr = "";

      const log_progress_output = _.debounce(
        (data) => {
          const lines = data.split("\n");
          /**
           * get last line, remove spinner, etc
           */
          const line = lines
            .slice(-1)[0]
            .trim()
            .replace(/^[\/\\\-\|] /gi, "");
          kopia.options.logger.info(
            `kopia ${options.operation} progress: ${line.trim()}`
          );
        },
        250,
        { leading: true, trailing: true, maxWait: 5000 }
      );

      child.stdout.on("data", function (data) {
        data = String(data);
        stdout += data;
      });

      child.stderr.on("data", function (data) {
        data = String(data);
        stderr += data;
        switch (options.operation) {
          case "snapshot-create":
            log_progress_output(data);
            break;
          default:
            break;
        }
      });

      child.on("close", function (code) {
        const result = { code, stdout, stderr, timeout: false };

        if (!result.parsed) {
          try {
            result.parsed = JSON.parse(result.stdout);
          } catch (err) {}
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

module.exports.Kopia = Kopia;
