const request = require("request");
const Mutex = require("async-mutex").Mutex;

const USER_AGENT = "democratic-csi";

class SynologyHttpClient {
  constructor(options = {}) {
    this.options = JSON.parse(JSON.stringify(options));
    this.logger = console;
    this.doLoginMutex = new Mutex();
    this.apiSerializeMutex = new Mutex();

    if (false) {
      setInterval(() => {
        console.log("WIPING OUT SYNOLOGY SID");
        this.sid = null;
      }, 5 * 1000);
    }
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

      let response = await this.do_request("GET", "auth.cgi", data);
      this.sid = response.body.data.sid;
    }

    return this.sid;
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

  async do_request(method, path, data = {}, options = {}) {
    const client = this;
    const isAuth = data.api == "SYNO.API.Auth" && data.method == "login";
    let sid;
    let apiMutexRelease;
    if (!isAuth) {
      sid = await this.doLoginMutex.runExclusive(async () => {
        return await this.login();
      });
    }

    const invoke_options = options;

    if (!isAuth) {
      if (this.options.serialize) {
        apiMutexRelease = await this.apiSerializeMutex.acquire();
      }
    }

    return new Promise((resolve, reject) => {
      if (!isAuth) {
        data._sid = sid;
      }

      const options = {
        method: method,
        url: `${this.options.protocol}://${this.options.host}:${this.options.port}/webapi/${path}`,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Content-Type": invoke_options.use_form_encoded
            ? "application/x-www-form-urlencoded"
            : "application/json",
        },
        json: invoke_options.use_form_encoded ? false : true,
        agentOptions: {
          rejectUnauthorized: !!!client.options.allowInsecure,
        },
      };

      switch (method) {
        case "GET":
          let qsData = JSON.parse(JSON.stringify(data));
          for (let p in qsData) {
            if (Array.isArray(qsData[p])) {
              qsData[p] = JSON.stringify(qsData[p]);
            }
          }
          options.qs = qsData;
          break;
        default:
          if (invoke_options.use_form_encoded) {
            //options.body = URLSearchParams(data);
            options.form = data;
          } else {
            options.body = data;
          }
          break;
      }

      try {
        request(options, function (error, response, body) {
          client.log_response(...arguments, options);

          if (error) {
            reject(error);
          }

          if (
            typeof response.body !== "object" &&
            response.body !== null &&
            response.headers["content-type"] &&
            response.headers["content-type"].includes("application/json")
          ) {
            response.body = JSON.parse(response.body);
          }

          if (response.statusCode > 299 || response.statusCode < 200) {
            reject(response);
          }

          if (response.body.success === false) {
            // remove invalid sid
            if (response.body.error.code == 119 && sid == client.sid) {
              client.sid = null;
            }
            reject(response);
          }

          resolve(response);
        });
      } finally {
        if (typeof apiMutexRelease == "function") {
          apiMutexRelease();
        }
      }
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

  async GetLunIDByName(name) {
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
      return lun.lun_id;
    }
  }

  async GetLunByID(lun_id) {
    const lun_list = {
      api: "SYNO.Core.ISCSI.LUN",
      version: "1",
      method: "list",
    };

    let response = await this.do_request("GET", "entry.cgi", lun_list);
    let lun = response.body.data.luns.find((i) => {
      return i.lun_id == lun_id;
    });

    if (lun) {
      return lun;
    }
  }

  async GetLunByName(name) {
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
      return lun;
    }
  }

  async GetSnapshotByLunIDAndName(lun_id, name) {
    const get_snapshot_info = {
      lid: lun_id, //check?
      api: "SYNO.Core.Storage.iSCSILUN",
      method: "load_snapshot",
      version: 1,
    };

    let response = await this.do_request("GET", "entry.cgi", get_snapshot_info);

    if (response.body.data) {
      let snapshot = response.body.data.find((i) => {
        return i.desc == name;
      });

      if (snapshot) {
        return snapshot;
      }
    }
  }

  async GetSnapshotByLunIDAndSnapshotUUID(lun_id, snapshot_uuid) {
    const get_snapshot_info = {
      lid: lun_id, //check?
      api: "SYNO.Core.Storage.iSCSILUN",
      method: "load_snapshot",
      version: 1,
    };

    let response = await this.do_request("GET", "entry.cgi", get_snapshot_info);

    if (response.body.data) {
      let snapshot = response.body.data.find((i) => {
        return i.uuid == snapshot_uuid;
      });

      if (snapshot) {
        return snapshot;
      }
    }
  }

  async DeleteSnapshot(snapshot_uuid) {
    const iscsi_snapshot_delete = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "delete_snapshot",
      version: 1,
      snapshot_uuid: JSON.stringify(snapshot_uuid), // snapshot_id
      deleted_by: "democratic_csi", // ?
    };

    let response = await this.do_request(
      "GET",
      "entry.cgi",
      iscsi_snapshot_delete
    );
    // return?
  }

  async GetVolumeInfo(volume_path) {
    let data = {
      api: "SYNO.Core.Storage.Volume",
      method: "get",
      version: "1",
      //volume_path: "/volume1",
      volume_path,
    };

    return await this.do_request("GET", "entry.cgi", data);
  }

  async GetTargetByTargetID(target_id) {
    let targets = await this.ListTargets();
    let target = targets.find((i) => {
      return i.target_id == target_id;
    });

    return target;
  }

  async GetTargetByIQN(iqn) {
    let targets = await this.ListTargets();
    let target = targets.find((i) => {
      return i.iqn == iqn;
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
    let iscsi_lun_create = Object.assign({}, data, {
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
    let iscsi_target_map = Object.assign({}, data, {
      api: "SYNO.Core.ISCSI.LUN",
      method: "map_target",
      version: "1",
    });
    iscsi_target_map.uuid = JSON.stringify(iscsi_target_map.uuid);
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
    uuid = uuid || "";
    let iscsi_lun_delete = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "delete",
      version: 1,
      //uuid: uuid,
      uuid: JSON.stringify(""),
      uuids: JSON.stringify([uuid]),
      //is_soft_feas_ignored: false,
      is_soft_feas_ignored: true,
      //feasibility_precheck: true,
    };

    await this.do_request("GET", "entry.cgi", iscsi_lun_delete);
  }

  async DeleteAllLuns() {
    const lun_list = {
      api: "SYNO.Core.ISCSI.LUN",
      version: "1",
      method: "list",
    };

    let response = await this.do_request("GET", "entry.cgi", lun_list);
    for (let lun of response.body.data.luns) {
      await this.DeleteLun(lun.uuid);
    }
  }

  async CreateSnapshot(data) {
    data = Object.assign({}, data, {
      api: "SYNO.Core.ISCSI.LUN",
      method: "take_snapshot",
      version: 1,
    });

    data.src_lun_uuid = JSON.stringify(data.src_lun_uuid);

    return await this.do_request("GET", "entry.cgi", data);
  }

  async CreateTarget(data = {}) {
    let iscsi_target_create = Object.assign({}, data, {
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

        if (target) {
          return target.target_id;
        } else {
          throw err;
        }
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
        Object.assign({}, iscsi_target_delete, {
          target_id: JSON.stringify(String(target_id || "")),
        })
      );
    } catch (err) {
      /**
       * 18990710 = non-existant
       */
      //if (![18990710].includes(err.body.error.code)) {
      throw err;
      //}
    }
  }

  async ExpandISCSILun(uuid, size) {
    const iscsi_lun_extend = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "set",
      version: 1,
    };

    return await this.do_request(
      "GET",
      "entry.cgi",
      Object.assign({}, iscsi_lun_extend, { uuid: JSON.stringify(uuid), new_size: size })
    );
  }

  async CreateClonedVolume(src_lun_uuid, dst_lun_name) {
    const create_cloned_volume = {
      api: "SYNO.Core.ISCSI.LUN",
      version: 1,
      method: "clone",
      src_lun_uuid: JSON.stringify(src_lun_uuid), // src lun uuid
      dst_lun_name: dst_lun_name, // dst lun name
      is_same_pool: true, // always true? string?
      clone_type: "democratic-csi", // check
    };
    return await this.do_request("GET", "entry.cgi", create_cloned_volume);
  }

  async CreateVolumeFromSnapshot(src_lun_uuid, snapshot_uuid, cloned_lun_name) {
    const create_volume_from_snapshot = {
      api: "SYNO.Core.ISCSI.LUN",
      version: 1,
      method: "clone_snapshot",
      src_lun_uuid: JSON.stringify(src_lun_uuid), // src lun uuid, snapshot id?
      snapshot_uuid: JSON.stringify(snapshot_uuid), // shaptop uuid
      cloned_lun_name: cloned_lun_name, // cloned lun name
      clone_type: "democratic-csi", // check
    };
    return await this.do_request(
      "GET",
      "entry.cgi",
      create_volume_from_snapshot
    );
  }
}

module.exports.SynologyHttpClient = SynologyHttpClient;
