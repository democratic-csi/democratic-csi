const request = require("request");
const URI = require("uri-js");
const USER_AGENT = "democratic-csi-driver";

class Client {
  constructor(options = {}) {
    this.options = options;
    this.logger = console;

    // default to v1.0 for now
    if (!this.options.apiVersion) {
      this.options.apiVersion = 1;
    }
  }
  getBaseURL() {
    const server = this.options;
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

  log_repsonse(error, response, body, options) {
    this.logger.debug("FREENAS HTTP REQUEST: " + JSON.stringify(options));
    this.logger.debug("FREENAS HTTP ERROR: " + error);
    this.logger.debug("FREENAS HTTP STATUS: " + response.statusCode);
    this.logger.debug(
      "FREENAS HTTP HEADERS: " + JSON.stringify(response.headers)
    );
    this.logger.debug("FREENAS HTTP BODY: " + JSON.stringify(body));
  }

  async get(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "GET",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        json: true,
        qs: data,
        agentOptions: {
          rejectUnauthorized: !!!client.options.allowInsecure,
        },
      };
      request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(
        client.options.username,
        client.options.password,
        true,
        client.options.apiKey
      );
    });
  }

  async post(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "POST",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        json: true,
        body: data,
        agentOptions: {
          rejectUnauthorized: !!!client.options.allowInsecure,
        },
      };
      request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(
        client.options.username,
        client.options.password,
        true,
        client.options.apiKey
      );
    });
  }

  async put(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "PUT",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        json: true,
        body: data,
        agentOptions: {
          rejectUnauthorized: !!!client.options.allowInsecure,
        },
      };
      request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(
        client.options.username,
        client.options.password,
        true,
        client.options.apiKey
      );
    });
  }

  async delete(endpoint, data) {
    const client = this;
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "DELETE",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        json: true,
        body: data,
        agentOptions: {
          rejectUnauthorized: !!!client.options.allowInsecure,
        },
      };
      request(options, function (err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(
        client.options.username,
        client.options.password,
        true,
        client.options.apiKey
      );
    });
  }
}

module.exports.Client = Client;
