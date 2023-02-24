const cp = require("child_process");

class LocalCliExecClient {
  constructor(options = {}) {
    this.options = options;
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

  async exec(command, options = {}) {
    return new Promise((resolve, reject) => {
      this.logger.verbose("LocalCliExecClient command: " + command);
      let process = cp.exec(command, (err, stdout, stderr) => {
        if (err) {
          reject(err);
        }
        resolve({
          stderr,
          stdout,
          code: process.exitCode,
          signal: process.exitSignal,
        });
      });
    });
  }

  /**
   * simple wrapper for logging
   */
  spawn() {
    const command = this.buildCommand(arguments[0], arguments[1]);
    this.logger.verbose("LocalCliExecClient command: " + command);
    return cp.exec(command);
  }
}

module.exports.LocalCliClient = LocalCliExecClient;
