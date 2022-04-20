const _ = require("lodash");
const http = require("http");
const https = require("https");
const URI = require("uri-js");
const { axios_request, stringify } = require("../../../utils/general");
const USER_AGENT = "democratic-csi-driver";

class Client {
  constructor(options = {}) {
    this.options = JSON.parse(JSON.stringify(options));
    this.logger = console;

    // default to v1.0 for now
    if (!this.options.apiVersion) {
      this.options.apiVersion = 1;
    }
  }

  getHttpAgent() {
    if (!this.httpAgent) {
      this.httpAgent = new http.Agent({
        keepAlive: true,
        maxSockets: Infinity,
        rejectUnauthorized: !!!this.options.allowInsecure,
      });
    }

    return this.httpAgent;
  }

  getHttpsAgent() {
    if (!this.httpsAgent) {
      this.httpsAgent = new https.Agent({
        keepAlive: true,
        maxSockets: Infinity,
        rejectUnauthorized: !!!this.options.allowInsecure,
      });
    }

    return this.httpsAgent;
  }

  getBaseURL() {
    const server = this.options;
    if (!server.protocol) {
      if (server.port) {
        if (String(server.port).includes("80")) {
          server.protocol = "http";
        }
        if (String(server.port).includes("443")) {
          server.protocol = "https";
        }
      }
    }
    if (!server.protocol) {
      server.protocol = "http";
    }

    const options = {
      scheme: server.protocol,
      host: server.host,
      port: server.port,
      //userinfo: server.username + ":" + server.password,
      path: server.apiVersion == 1 ? "/api/v1.0" : "/api/v2.0",
    };
    return URI.serialize(options);
  }

  setApiVersion(apiVersion) {
    this.options.apiVersion = apiVersion;
  }

  getApiVersion() {
    return this.options.apiVersion;
  }

  getRequestCommonOptions() {
    const client = this;
    const options = {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      responseType: "json",
      httpAgent: this.getHttpAgent(),
      httpsAgent: this.getHttpsAgent(),
      timeout: 60 * 1000,
    };

    if (client.options.apiKey) {
      options.headers.Authorization = `Bearer ${client.options.apiKey}`;
    } else if (client.options.username && client.options.password) {
      options.auth = {
        username: client.options.username,
        password: client.options.password,
      };
    }

    return options;
  }

  log_repsonse(error, response, body, options) {
    let prop;
    let val;

    prop = "auth.username";
    val = _.get(options, prop, false);
    if (val) {
      _.set(options, prop, "redacted");
    }

    prop = "auth.password";
    val = _.get(options, prop, false);
    if (val) {
      _.set(options, prop, "redacted");
    }

    prop = "headers.Authorization";
    val = _.get(options, prop, false);
    if (val) {
      _.set(options, prop, "redacted");
    }

    delete options.httpAgent;
    delete options.httpsAgent;

    this.logger.debug("FREENAS HTTP REQUEST: " + stringify(options));
    this.logger.debug("FREENAS HTTP ERROR: " + error);
    this.logger.debug("FREENAS HTTP STATUS: " + response.statusCode);
    this.logger.debug("FREENAS HTTP HEADERS: " + stringify(response.headers));
    this.logger.debug("FREENAS HTTP BODY: " + stringify(body));
  }

  async get(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = client.getRequestCommonOptions();
      options.method = "GET";
      options.url = this.getBaseURL() + endpoint;
      options.params = data;

      axios_request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }
        resolve(res);
      });
    });
  }

  async post(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = client.getRequestCommonOptions();
      options.method = "POST";
      options.url = this.getBaseURL() + endpoint;
      options.data = data;

      axios_request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      });
    });
  }

  async put(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = client.getRequestCommonOptions();
      options.method = "PUT";
      options.url = this.getBaseURL() + endpoint;
      options.data = data;

      axios_request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      });
    });
  }

  async delete(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = client.getRequestCommonOptions();
      options.method = "DELETE";
      options.url = this.getBaseURL() + endpoint;
      options.data = data;

      axios_request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      });
    });
  }
}

module.exports.Client = Client;
