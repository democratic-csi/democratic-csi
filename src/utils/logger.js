const os = require("os");

/**
 * Levels
 *
 * error: 0
 * warn: 1
 * info: 2
 * verbose: 3
 * debug: 4
 * silly: 5
 */

const winston = require("winston");
const bunyan = require("bunyan");

const env = process.env.NODE_ENV || "development";
let level = process.env.DEMOCRATIC_CSI_LOG_LEVEL || null;

if (!level) {
  if (env == "production") {
    level = "info";
  } else {
    level = "verbose";
  }
}

let formatters;
let defaultMeta;
if (env == "production") {
  formatters = [winston.format.json()];
  defaultMeta = { service: "democratic-csi", host: os.hostname() };
} else {
  formatters = [winston.format.colorize(), winston.format.simple()];
  defaultMeta = {};
}

const logger = winston.createLogger({
  level: level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    ...formatters
  ),
  defaultMeta: defaultMeta,
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
    }),
  ],
});

/**
 * A Bunyan raw stream object (i.e. has a `.write(rec)` method that takes a
 * Bunyan log record) that shims logging to a given Winston logger.
 *
 * @param {winston.Logger} wlog is a Winston Logger to which to shim.
 */
function Bunyan2Winston(wlog) {
  this.wlog = wlog;
}
Bunyan2Winston.prototype.write = function write(rec) {
  // Map to the appropriate Winston log level (by default 'info', 'warn'
  // or 'error') and call signature: `wlog.log(level, msg, metadata)`.
  var wlevel;
  if (rec.level <= bunyan.INFO) {
    wlevel = "info";
  } else if (rec.level <= bunyan.WARN) {
    wlevel = "warn";
  } else {
    wlevel = "error";
  }

  // Note: We are *modifying* the log record here. This could be a problem
  // if our Bunyan logger had other streams. This one doesn't.
  var msg = rec.msg;
  delete rec.msg;

  // Remove internal bunyan fields that won't mean anything outside of
  // a bunyan context.
  delete rec.v;
  delete rec.level;
  // TODO: more?

  // Note: Winston doesn't handle *objects* in the 'metadata' field well
  // (e.g. the Bunyan record 'time' field is a Date instance, 'req' and
  // 'res' are typically objects). With 'json: true' on a Winston transport
  // it is a bit better, but still messes up 'date'. What exactly to do
  // here is perhaps user-preference.
  rec.time = String(rec.time);
  //Object.keys(rec).forEach(function (key) {
  //    if (typeof(rec[key]) === "object") {
  //        rec[key] = JSON.stringify(rec[key])
  //    }
  //});

  this.wlog.log(wlevel, msg, rec);
};

// Pass a Bunyan logger to restify that shims to our winston Logger.
var shim = bunyan.createLogger({
  name: "eas",
  streams: [
    {
      type: "raw",
      level: "trace",
      stream: new Bunyan2Winston(logger),
    },
  ],
});

logger.bunyan = shim;

//global.console = logger;

module.exports = {
  logger: logger,
};
