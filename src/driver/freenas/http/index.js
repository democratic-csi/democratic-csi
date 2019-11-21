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
      path: server.apiVersion == 1 ? "/api/v1.0" : "/api/v2.0"
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
    // curl -X GET "http://bitness.lan/api/v2.0/core/ping" -H  "accept: */*"
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "GET",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "*/*",
          "User-Agent": USER_AGENT
        },
        json: true,
        qs: data
      };
      request(options, function(err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(client.options.username, client.options.password);
    });
  }

  async post(endpoint, data) {
    const client = this;
    // curl -X POST "http://bitness.lan/api/v2.0/core/get_methods" -H  "accept: */*" -H  "Content-Type: application/json" -d "\"string\""
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "POST",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "*/*",
          "User-Agent": USER_AGENT
        },
        json: true,
        body: data
      };
      request(options, function(err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(client.options.username, client.options.password);
    });
  }

  async put(endpoint, data) {
    const client = this;
    // curl -X PUT "http://bitness.lan/api/v2.0/sharing/smb/id/1" -H  "accept: */*" -H  "Content-Type: application/json" -d "{\"path\":\"string\",\"home\":true,\"name\":\"string\",\"comment\":\"string\",\"ro\":true,\"browsable\":true,\"timemachine\":true,\"recyclebin\":true,\"showhiddenfiles\":true,\"guestok\":true,\"guestonly\":true,\"abe\":true,\"hostsallow\":[null],\"hostsdeny\":[null],\"vfsobjects\":[null],\"storage_task\":0,\"auxsmbconf\":\"string\",\"default_permissions\":true}"
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "PUT",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "*/*",
          "User-Agent": USER_AGENT
        },
        json: true,
        body: data
      };
      request(options, function(err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(client.options.username, client.options.password);
    });
  }

  //Unauthorized
  async delete(endpoint, data) {
    const client = this;
    // curl -X DELETE "http://bitness.lan/api/v2.0/sharing/smb/id/1" -H  "accept: */*" -H  "Content-Type: application/json" -d "{}"
    if (this.options.apiVersion == 1 && !endpoint.endsWith("/")) {
      endpoint += "/";
    }

    return new Promise((resolve, reject) => {
      const options = {
        method: "DELETE",
        url: this.getBaseURL() + endpoint,
        headers: {
          Accept: "*/*",
          "User-Agent": USER_AGENT
        },
        json: true,
        body: data
      };
      request(options, function(err, res, body) {
        client.log_repsonse(...arguments, options);
        if (err) {
          reject(err);
        }

        resolve(res);
      }).auth(client.options.username, client.options.password);
    });
  }
}

module.exports.Client = Client;
