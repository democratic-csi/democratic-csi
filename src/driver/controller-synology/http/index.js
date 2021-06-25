const request = require("request");

const USER_AGENT = "democratic-csi";

class SynologyHttpClient {
  constructor(options = {}) {
    this.options = JSON.parse(JSON.stringify(options));
    this.logger = console;

    setInterval(() => {
      console.log("WIPING OUT SYNOLOGY SID");
      this.sid = null;
    }, 60 * 1000);
  }

  async login() {
    if (!this.sid) {
      const data = {
        api: "SYNO.API.Auth",
        version: "2",
        method: "login",
        account: this.options.username,
        passwd: this.options.password,
        session: this.options.session,
        format: "sid",
      };

      this.authenticating = true;
      let response = await this.do_request("GET", "auth.cgi", data);
      this.sid = response.body.data.sid;
      this.authenticating = false;
    }
  }

  log_response(error, response, body, options) {
    this.logger.debug("SYNOLOGY HTTP REQUEST: " + JSON.stringify(options));
    this.logger.debug("SYNOLOGY HTTP ERROR: " + error);
    this.logger.debug("SYNOLOGY HTTP STATUS: " + response.statusCode);
    this.logger.debug(
      "SYNOLOGY HTTP HEADERS: " + JSON.stringify(response.headers)
    );
    this.logger.debug("SYNOLOGY HTTP BODY: " + JSON.stringify(body));
  }

  async do_request(method, path, data = {}) {
    const client = this;
    if (!this.authenticating) {
      await this.login();
    }

    return new Promise((resolve, reject) => {
      if (data.api != "SYNO.API.Auth") {
        data._sid = this.sid;
      }

      const options = {
        method: method,
        url: `${this.options.protocol}://${this.options.host}:${this.options.port}/webapi/${path}`,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        json: true,
        agentOptions: {
          rejectUnauthorized: !!!client.options.allowInsecure,
        },
      };

      switch (method) {
        case "GET":
          options.qs = data;
          break;
        default:
          options.body = data;
          break;
      }

      request(options, function (error, response, body) {
        client.log_response(...arguments, options);

        if (error) {
          reject(error);
        }

        if (response.statusCode > 299 || response.statusCode < 200) {
          reject(response);
        }

        if (response.body.success === false) {
          reject(response);
        }

        resolve(response);
      });
    });
  }

  async GetLunUUIDByName(name) {
    const lun_list = {
      api: "SYNO.Core.ISCSI.LUN",
      version: "1",
      method: "list",
    };

    let response = await this.do_request("GET", "entry.cgi", lun_list);
    let lun = response.body.data.luns.find((i) => {
      return i.name == name;
    });

    if (lun) {
      return lun.uuid;
    }
  }

  async GetTargetByTargetID(target_id) {
    let targets = await this.ListTargets();
    let target = targets.find((i) => {
      return i.target_id == target_id;
    });

    return target;
  }

  async ListTargets() {
    const iscsi_target_list = {
      api: "SYNO.Core.ISCSI.Target",
      version: "1",
      path: "entry.cgi",
      method: "list",
      additional: '["mapped_lun", "status", "acls", "connected_sessions"]',
    };
    let response = await this.do_request("GET", "entry.cgi", iscsi_target_list);
    return response.body.data.targets;
  }

  async CreateLun(data = {}) {
    let response;
    let iscsi_lun_create = Object.assign(data, {
      api: "SYNO.Core.ISCSI.LUN",
      version: "1",
      method: "create",
    });

    const lun_list = {
      api: "SYNO.Core.ISCSI.LUN",
      version: "1",
      method: "list",
    };

    try {
      response = await this.do_request("GET", "entry.cgi", iscsi_lun_create);
      return response.body.data.uuid;
    } catch (err) {
      if ([18990538].includes(err.body.error.code)) {
        response = await this.do_request("GET", "entry.cgi", lun_list);
        let lun = response.body.data.luns.find((i) => {
          return i.name == iscsi_lun_create.name;
        });
        return lun.uuid;
      } else {
        throw err;
      }
    }
  }

  async MapLun(data = {}) {
    // this is mapping from the perspective of the lun
    let iscsi_target_map = Object.assign(data, {
      api: "SYNO.Core.ISCSI.LUN",
      method: "map_target",
      version: "1",
    });
    iscsi_target_map.target_ids = JSON.stringify(iscsi_target_map.target_ids);

    // this is mapping from the perspective of the target
    /*
    iscsi_target_map = Object.assign(data, {
      api: "SYNO.Core.ISCSI.Target",
      method: "map_lun",
      version: "1",
    });
    iscsi_target_map.lun_uuids = JSON.stringify(iscsi_target_map.lun_uuids);
    */

    await this.do_request("GET", "entry.cgi", iscsi_target_map);
  }

  async DeleteLun(uuid) {
    let iscsi_lun_delete = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "delete",
      version: 1,
      uuid: uuid || "",
    };
    try {
      await this.do_request("GET", "entry.cgi", iscsi_lun_delete);
    } catch (err) {
      if (![18990505].includes(err.body.error.code)) {
        throw err;
      }
    }
  }

  async GetTargetIDByIQN(iqn) {
    const iscsi_target_list = {
      api: "SYNO.Core.ISCSI.Target",
      version: "1",
      path: "entry.cgi",
      method: "list",
      additional: '["mapped_lun", "status", "acls", "connected_sessions"]',
    };

    let response = await this.do_request("GET", "entry.cgi", iscsi_target_list);
    let target = response.body.data.targets.find((i) => {
      return i.iqn == iqn;
    });

    if (target) {
      return target.target_id;
    }
  }

  async CreateTarget(data = {}) {
    let iscsi_target_create = Object.assign(data, {
      api: "SYNO.Core.ISCSI.Target",
      version: "1",
      method: "create",
    });

    let response;

    try {
      response = await this.do_request("GET", "entry.cgi", iscsi_target_create);

      return response.body.data.target_id;
    } catch (err) {
      if ([18990744].includes(err.body.error.code)) {
        //do lookup
        const iscsi_target_list = {
          api: "SYNO.Core.ISCSI.Target",
          version: "1",
          path: "entry.cgi",
          method: "list",
          additional: '["mapped_lun", "status", "acls", "connected_sessions"]',
        };

        response = await this.do_request("GET", "entry.cgi", iscsi_target_list);
        let target = response.body.data.targets.find((i) => {
          return i.iqn == iscsi_target_create.iqn;
        });

        let target_id = target.target_id;
        return target_id;
      } else {
        throw err;
      }
    }
  }

  async DeleteTarget(target_id) {
    const iscsi_target_delete = {
      api: "SYNO.Core.ISCSI.Target",
      method: "delete",
      version: "1",
      path: "entry.cgi",
    };

    try {
      await this.do_request(
        "GET",
        "entry.cgi",
        Object.assign(iscsi_target_delete, {
          target_id: JSON.stringify(String(target_id || "")),
        })
      );
    } catch (err) {
      /**
       * 18990710 = non-existant
       */
      if (![18990710].includes(err.body.error.code)) {
        throw err;
      }
    }
  }

  async ExpandISCSILun(uuid, size) {
    const iscsi_lun_extend = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "set",
      version: 1,
    };

    await this.do_request(
      "GET",
      "entry.cgi",
      Object.assign(iscsi_lun_extend, { uuid: uuid, new_size: size })
    );
  }
}

module.exports.SynologyHttpClient = SynologyHttpClient;
