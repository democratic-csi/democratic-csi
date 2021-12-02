var Client = require("ssh2").Client;

class SshClient {
  constructor(options = {}) {
    this.options = options;
    this.options.connection = this.options.connection || {};
    if (this.options.logger) {
      this.logger = this.options.logger;
    } else {
      this.logger = console;
    }
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

  async exec(command, options = {}, stream_proxy = null) {
    const client = this;
    return new Promise((resolve, reject) => {
      var conn = new Client();

      if (client.options.connection.debug == true) {
        client.options.connection.debug = function (msg) {
          client.debug(msg);
        };
      }

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
            if (err) reject(err);
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
