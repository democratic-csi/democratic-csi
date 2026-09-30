/**
 *
 * https://www.truenas.com/docs/api/scale_websocket_api.html
 * https://github.com/truenas/api_client
 *
 * base websocket client functionality here
 */

const _ = require("lodash");
const EventEmitter = require("node:events");
const WebSocket = require("ws");
const ReconnectingWebSocket = require("reconnecting-websocket");
const uuidv4 = require("uuid").v4;

const GeneralUtils = require("../../../utils/general");

class TrueNASError extends Error {
  constructor(rpcError, options = {}) {
    super(rpcError.reason ?? "TrueNAS RPC error", {
      cause: options.cause,
    });

    this.name = "TrueNASError";

    // Node.js-style error properties
    this.code = rpcError.errname; // "ENOENT"
    this.errno = rpcError.error; // 2

    // TrueNAS-specific properties
    this.type = rpcError.type; // "VALIDATION"
    this.reason = rpcError.reason;

    // TrueNAS Python exception information
    this.remoteClass = rpcError.trace?.class;
    this.remoteTrace = rpcError.trace?.formatted;
    this.remoteRepr = rpcError.trace?.repr;

    // Additional TrueNAS error information
    this.extra = rpcError.extra;

    // Preserve the complete response error
    this.rpcError = rpcError;
  }
}

class TimeoutError extends Error {
  constructor(message = "Operation timed out", options = {}) {
    super(message, options);

    this.name = "TimeoutError";
    this.code = "ETIMEDOUT";
  }
}

class Client extends EventEmitter {
  constructor(options = {}, logger = null) {
    super();

    const client = this;
    this.options = JSON.parse(JSON.stringify(options));
    this.logger = logger;
    if (!this.logger) {
      this.logger = console;
    }

    // rewrite protocol
    switch (String(this.options.protocol).toLowerCase()) {
      case "http":
        this.options.protocol = "ws";
        break;
      case "https":
        this.options.protocol = "wss";
        break;
    }

    // legacy endpoint
    // this.url = `${this.options.protocol}://${this.options.host}:${this.options.port}/websocket`;

    // JSON-RPC 2.0 endpoint
    this.url = `${this.options.protocol}://${this.options.host}:${this.options.port}/api/current`;
    this.logger.info(`TrueNAS WebSocket connecting to: ${this.url}`);
    this.wss = new ReconnectingWebSocket(this.url, [], {
      WebSocket: class extends WebSocket {
        constructor(url, protocols) {
          // https://github.com/websockets/ws/blob/master/doc/ws.md#class-websocket
          super(url, protocols, {
            rejectUnauthorized: !!!client.options.allowInsecure,
          });
        }
        send(data) {
          client.logger.debug(
            "TrueNAS WebSocket sending message: " +
              GeneralUtils.stringify(client.log_cleanse(JSON.parse(data))),
          );
          super.send(data);
        }
      },
      //connectionTimeout: 1000,
      startClosed: true,
      //debug: true,
    });
    this.session;
    this.authenticated = false;
    this._systemInfo = {};
    this._systemVersion = null;

    this.wss.addEventListener("open", async () => {
      this.logger.info("TrueNAS WebSocket opened!");
      await this.authenticate();
    });

    this.wss.addEventListener("close", () => {
      this.logger.warn("TrueNAS WebSocket closed!");
      this.session = null;
      this.authenticated = false;
      this._systemInfo = {};
      this._systemVersion = null;
    });

    this.wss.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data);
      client.logger.debug(
        "TrueNAS WebSocket received message: " +
          GeneralUtils.stringify(client.log_cleanse(data)),
      );

      // event pushed from server, not a response to an rpc call
      if (!data.id) {
        switch (data.method) {
          case "collection_update":
            // data.params.msg = added, changed, or removed
            this.emit(
              `event:${data.method}:${data.params.collection}:${data.params.msg}`,
              data,
            );
            this.emit(`event:${data.method}:${data.params.collection}`, data);
            this.emit(`event:${data.method}`, data);
            break;

          case "notify_unsubscribed":
            this.emit(`event:${data.method}:${data.params.collection}`, data);
            this.emit(`event:${data.method}`, data);
            break;

          default:
            this.logger.log(`unhandled event method: ${data.method}`);
            break;
        }
      }
    });

    this.wss.addEventListener("error", (err) => {
      this.logger.error("TrueNAS WebSocket received error!", err);
    });

    this.on("authenticated", () => {
      // TODO: make this return when all initialization is complete and set a 'ready' parameter
      let promises = [];
      this.call("system.info").then((result) => {
        this._systemInfo = result;
      });

      this.call("system.version").then((result) => {
        this._systemVersion = result;
      });

      //this.call("core.subscribe", ["*"]);
      //this.call("core.set_options", [{ legacy_jobs: false }]);
    });
  }

  log_cleanse(data) {
    let log = JSON.parse(JSON.stringify(data));

    let method = log?.method || "";

    if (String(method).startsWith("auth.")) {
      if (log.params && Array.isArray(log.params) && log.params.length > 0) {
        log.params = log.params.map(() => {
          return "redacted";
        });
      }
    }

    return log;
  }

  async systemInfo() {
    if (!Object.keys(this._systemInfo).length > 0) {
      this._systemInfo = await this.call("system.info");
    }

    return this._systemInfo;
  }

  async systemVersion() {
    if (!this._systemVersion) {
      this._systemVersion = await this.call("system.version");
    }
    return this._systemVersion;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.wss.addEventListener(
        "open",
        () => {
          resolve();
        },
        { once: true },
      );

      this.wss.addEventListener(
        "close",
        () => {
          reject();
        },
        { once: true },
      );

      this.wss.addEventListener(
        "error",
        () => {
          reject();
        },
        { once: true },
      );
      this.wss.reconnect();
    });

    // this keeps the connection alive, otherwise TN will drop it after a timeout on their end
    if (!this.pingInterval) {
      this.pingInterval = setInterval(() => {
        if (this.wss.readyState == WebSocket.OPEN) {
          this.wss._ws.ping();
        }
      }, 10 * 1000);
    }
  }

  async authenticate() {
    let method = "auth.login";
    let params = [this.options.username, this.options.password];

    if (this.options.apiKey && this.options.protocol == "ws") {
      throw new Error("TrueNAS WebSocket unable to use apiKey over clear text");
    }

    if (this.options.apiKey) {
      method = "auth.login_with_api_key";
      params = [this.options.apiKey];
    }

    return this.call(method, params).then((result) => {
      this.authenticated = result;
      if (result) {
        this.emit("authenticated");
      } else {
        this.wss.close();
      }
    });
  }

  async waitauthenticated(timeout = 3 * 1000) {
    let timeoutId;
    return new Promise((resolve, reject) => {
      if (this.authenticated) {
        resolve();
      }

      if (timeout) {
        timeoutId = setTimeout(() => {
          reject(
            new TimeoutError(
              `TrueNAS timeout waiting for authentication to complete`,
            ),
          );
        }, timeout);
      }

      setInterval(() => {
        if (this.authenticated) {
          resolve();
        }
      }, 100);
    });
  }

  async subscribe(events, options = {}) {
    if (!Array.isArray(events)) {
      events = [events];
    }
    return this.call("core.subscribe", events, options);
  }

  async unsubscribe(id, options = {}) {
    return this.call("core.unsubscribe", [id], options);
  }

  async call(method, params = [], options = {}) {
    const controller = new AbortController();
    let timeoutId;
    let timeout = options.timeout;
    let is_job_method = false;
    let wait_for_job = true;
    let job_id;

    const uuid = uuidv4();
    const req = {};
    req.jsonrpc = "2.0";
    req.id = uuid;
    req.msg = "method";
    req.method = method;
    req.params = params;

    switch (method) {
      case "filesystem.chown":
      case "filesystem.get":
      case "pool.scrub.scrub":
        is_job_method = true;
        break;
    }

    return new Promise((resolve, reject) => {
      if (timeout) {
        timeoutId = setTimeout(() => {
          reject(
            new TimeoutError(
              `TrueNAS timeout waiting for call response: type=${req.method}, id=${
                req.id
              }, params=[${params.join(" ")}]`,
            ),
          );
        }, timeout);
      }

      if (is_job_method && wait_for_job) {
        this.on(
          "event:core.get_jobs:changed",
          (event) => {
            if (event.id == job_id) {
              switch (event.fields.state) {
                case "FAILED":
                  reject(new TrueNASError(event.fields.error));
                  break;
                case "SUCCESS":
                case "ABORTED":
                  resolve(event.fields.result);
                  break;
                case "WAITING":
                case "RUNNING":
                default:
                  // ignore
                  break;
              }
            }
          },
          {
            signal: controller.signal,
          },
        );
      }

      this.wss.addEventListener(
        "message",
        (msg) => {
          const data = JSON.parse(msg.data);
          if (data.id == uuid) {
            if (data.error) {
              reject(new TrueNASError(data.error.data));
            } else {
              if (is_job_method && wait_for_job) {
                job_id = data.result;
              } else {
                resolve(data.result);
              }
            }
          }
        },
        {
          signal: controller.signal,
        },
      );

      this.wss.send(JSON.stringify(req));
    }).finally(() => {
      controller.abort();
      clearTimeout(timeoutId);
    });
  }
}

module.exports.Client = Client;
