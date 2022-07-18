const Client = require("ssh2").Client;
const { E_CANCELED, Mutex } = require("async-mutex");
const GeneralUtils = require("./general");

class SshClient {
  constructor(options = {}) {
    const client = this;
    this.options = options;
    this.options.connection = this.options.connection || {};
    if (this.options.logger) {
      this.logger = this.options.logger;
    } else {
      this.logger = console;
      console.silly = console.debug;
    }

    if (!this.options.connection.hasOwnProperty("keepaliveInterval")) {
      this.options.connection.keepaliveInterval = 10000;
    }

    if (this.options.connection.debug === true) {
      this.options.connection.debug = function (msg) {
        client.debug(msg);
      };
    }

    this.conn_mutex = new Mutex();
    this.conn_state;
    this.conn_err;
    this.ready_event_count = 0;
    this.error_event_count = 0;

    this.conn = new Client();
    // invoked before close
    this.conn.on("end", () => {
      this.conn_state = "ended";
      this.debug("Client :: end");
    });
    // invoked after end
    this.conn.on("close", () => {
      this.conn_state = "closed";
      this.debug("Client :: close");
    });
    this.conn.on("error", (err) => {
      this.conn_state = "error";
      this.conn_err = err;
      this.error_event_count++;
      this.debug("Client :: error");
    });
    this.conn.on("ready", () => {
      this.conn_state = "ready";
      this.ready_event_count++;
      this.debug("Client :: ready");
    });
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

  debug() {
    this.logger.silly(...arguments);
  }

  async _connect() {
    const start_ready_event_count = this.ready_event_count;
    const start_error_event_count = this.error_event_count;
    try {
      await this.conn_mutex.runExclusive(async () => {
        this.conn.connect(this.options.connection);
        do {
          if (start_error_event_count != this.error_event_count) {
            throw this.conn_err;
          }

          if (start_ready_event_count != this.ready_event_count) {
            break;
          }

          await GeneralUtils.sleep(100);
        } while (true);
      });
    } catch (err) {
      if (err === E_CANCELED) {
        return;
      }
      throw err;
    }
  }

  async connect() {
    if (this.conn_state == "ready") {
      return;
    }

    return this._connect();
  }

  async exec(command, options = {}, stream_proxy = null) {
    // default is to reuse
    if (process.env.SSH_REUSE_CONNECTION == "0") {
      return this._nexec(...arguments);
    } else {
      return this._rexec(...arguments);
    }
  }

  async _rexec(command, options = {}, stream_proxy = null) {
    const client = this;
    const conn = this.conn;

    return new Promise(async (resolve, reject) => {
      do {
        try {
          await this.connect();
          conn.exec(command, options, function (err, stream) {
            if (err) {
              reject(err);
              return;
            }
            let stderr;
            let stdout;

            if (stream_proxy) {
              stream_proxy.on("kill", (signal) => {
                stream.destroy();
              });
            }

            stream
              .on("close", function (code, signal) {
                client.debug(
                  "Stream :: close :: code: " + code + ", signal: " + signal
                );
                if (stream_proxy) {
                  stream_proxy.emit("close", ...arguments);
                }
                resolve({ stderr, stdout, code, signal });
                //conn.end();
              })
              .on("data", function (data) {
                client.debug("STDOUT: " + data);
                if (stream_proxy) {
                  stream_proxy.stdout.emit("data", ...arguments);
                }
                if (stdout == undefined) {
                  stdout = "";
                }
                stdout = stdout.concat(data);
              })
              .stderr.on("data", function (data) {
                client.debug("STDERR: " + data);
                if (stream_proxy) {
                  stream_proxy.stderr.emit("data", ...arguments);
                }
                if (stderr == undefined) {
                  stderr = "";
                }
                stderr = stderr.concat(data);
              });
          });
          break;
        } catch (err) {
          if (err.message && !err.message.includes("Not connected")) {
            throw err;
          }
        }
        await GeneralUtils.sleep(1000);
      } while (true);
    });
  }

  async _nexec(command, options = {}, stream_proxy = null) {
    const client = this;
    return new Promise((resolve, reject) => {
      var conn = new Client();

      conn
        .on("error", function (err) {
          client.debug("Client :: error");
          reject(err);
        })
        .on("ready", function () {
          client.debug("Client :: ready");
          //options.pty = true;
          //options.env = {
          //  TERM: "",
          //};
          conn.exec(command, options, function (err, stream) {
            if (err) {
              reject(err);
              return;
            }
            let stderr;
            let stdout;
            stream
              .on("close", function (code, signal) {
                client.debug(
                  "Stream :: close :: code: " + code + ", signal: " + signal
                );
                if (stream_proxy) {
                  stream_proxy.emit("close", ...arguments);
                }
                resolve({ stderr, stdout, code, signal });
                conn.end();
              })
              .on("data", function (data) {
                client.debug("STDOUT: " + data);
                if (stream_proxy) {
                  stream_proxy.stdout.emit("data", ...arguments);
                }
                if (stdout == undefined) {
                  stdout = "";
                }
                stdout = stdout.concat(data);
              })
              .stderr.on("data", function (data) {
                client.debug("STDERR: " + data);
                if (stream_proxy) {
                  stream_proxy.stderr.emit("data", ...arguments);
                }
                if (stderr == undefined) {
                  stderr = "";
                }
                stderr = stderr.concat(data);
              });
          });
        })
        .connect(client.options.connection);

      if (stream_proxy) {
        stream_proxy.on("kill", (signal) => {
          conn.end();
        });
      }
    });
  }
}

module.exports.SshClient = SshClient;
