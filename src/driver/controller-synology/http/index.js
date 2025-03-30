const _ = require("lodash");
const http = require("http");
const https = require("https");
const { axios_request, stringify } = require("../../../utils/general");
const Mutex = require("async-mutex").Mutex;
const { GrpcError, grpc } = require("../../../utils/grpc");

const USER_AGENT = "democratic-csi";
const __REGISTRY_NS__ = "SynologyHttpClient";

SYNO_ERRORS = {
  400: {
    status: grpc.status.UNAUTHENTICATED,
    message: "Failed to authenticate to the Synology DSM.",
  },
  407: {
    status: grpc.status.UNAUTHENTICATED,
    message:
      "IP has been blocked to the Synology DSM due to too many failed attempts.",
  },
  18990002: {
    status: grpc.status.RESOURCE_EXHAUSTED,
    message: "The synology volume is out of disk space.",
  },
  18990318: {
    status: grpc.status.INVALID_ARGUMENT,
    message:
      "The requested lun type is incompatible with the Synology filesystem.",
  },
  18990538: {
    status: grpc.status.ALREADY_EXISTS,
    message: "A LUN with this name already exists.",
  },
  18990541: {
    status: grpc.status.RESOURCE_EXHAUSTED,
    message: "The maximum number of LUNS has been reached.",
  },
  18990542: {
    status: grpc.status.RESOURCE_EXHAUSTED,
    message: "The maximum number if iSCSI target has been reached.",
  },
  18990708: {
    status: grpc.status.INVALID_ARGUMENT,
    message: "Bad target auth info.",
  },
  18990744: {
    status: grpc.status.ALREADY_EXISTS,
    message: "An iSCSI target with this name already exists.",
  },
  18990532: { status: grpc.status.NOT_FOUND, message: "No such snapshot." },
  18990500: { status: grpc.status.INVALID_ARGUMENT, message: "Bad LUN type" },
  18990543: {
    status: grpc.status.RESOURCE_EXHAUSTED,
    message: "Maximum number of snapshots reached.",
  },
  18990635: {
    status: grpc.status.INVALID_ARGUMENT,
    message: "Invalid ioPolicy.",
  },
};

class SynologyError extends GrpcError {
  constructor(code, httpCode = undefined) {
    super(0, "");
    this.synoCode = code;
    this.httpCode = httpCode;
    if (code > 0) {
      const error = SYNO_ERRORS[code];
      this.code = error && error.status ? error.status : grpc.status.UNKNOWN;
      this.message =
        error && error.message
          ? error.message
          : `An unknown error occurred when executing a synology command (code = ${code}).`;
    } else {
      this.code = grpc.status.UNKNOWN;
      this.message = `The synology webserver returned a status code ${httpCode}`;
    }
  }
}

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

  getHttpAgent() {
    return this.ctx.registry.get(`${__REGISTRY_NS__}:http_agent`, () => {
      return new http.Agent({
        keepAlive: true,
        maxSockets: Infinity,
        rejectUnauthorized: !!!this.options.allowInsecure,
      });
    });
  }

  getHttpsAgent() {
    return this.ctx.registry.get(`${__REGISTRY_NS__}:https_agent`, () => {
      return new https.Agent({
        keepAlive: true,
        maxSockets: Infinity,
        rejectUnauthorized: !!!this.options.allowInsecure,
      });
    });
  }

  log_response(error, response, body, options) {
    const cleansedBody = JSON.parse(stringify(body));
    const cleansedOptions = JSON.parse(stringify(options));
    // This function handles arrays and objects
    function recursiveCleanse(obj) {
      for (const k in obj) {
        if (typeof obj[k] == "object" && obj[k] !== null) {
          recursiveCleanse(obj[k]);
        } else {
          if (
            [
              "account",
              "passwd",
              "username",
              "password",
              "_sid",
              "sid",
              "Authorization",
              "authorization",
              "user",
              "mutual_user",
              "mutual_password",
            ].includes(k)
          ) {
            obj[k] = "redacted";
          }
        }
      }
    }
    recursiveCleanse(cleansedBody);
    recursiveCleanse(cleansedOptions);

    delete cleansedOptions.httpAgent;
    delete cleansedOptions.httpsAgent;

    this.logger.debug("SYNOLOGY HTTP REQUEST: " + stringify(cleansedOptions));
    this.logger.debug("SYNOLOGY HTTP ERROR: " + error);
    this.logger.debug(
      "SYNOLOGY HTTP STATUS: " + _.get(response, "statusCode", "")
    );
    this.logger.debug(
      "SYNOLOGY HTTP HEADERS: " + stringify(_.get(response, "headers", ""))
    );
    this.logger.debug("SYNOLOGY HTTP BODY: " + stringify(cleansedBody));
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
        responseType: "json",
        httpAgent: this.getHttpAgent(),
        httpsAgent: this.getHttpsAgent(),
        timeout: 60 * 1000,
      };

      switch (method) {
        case "GET":
          let qsData = JSON.parse(JSON.stringify(data));
          for (let p in qsData) {
            if (Array.isArray(qsData[p]) || typeof qsData[p] == "boolean") {
              qsData[p] = JSON.stringify(qsData[p]);
            }
          }
          options.params = qsData;
          break;
        default:
          if (invoke_options.use_form_encoded) {
            options.data = URLSearchParams(data).toString();
          } else {
            options.data = data;
          }
          break;
      }

      try {
        axios_request(options, function (error, response, body) {
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
            reject(new SynologyError(null, response.statusCode));
          }

          if (response.body.success === false) {
            // remove invalid sid
            if (response.body.error.code == 119 && sid == client.sid) {
              client.sid = null;
            }
            reject(
              new SynologyError(response.body.error.code, response.statusCode)
            );
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

  async login() {
    if (!this.sid) {
      // See https://global.download.synology.com/download/Document/Software/DeveloperGuide/Os/DSM/All/enu/DSM_Login_Web_API_Guide_enu.pdf
      const data = {
        api: "SYNO.API.Auth",
        version: "6",
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

  async GetLuns() {
    const lun_list = {
      api: "SYNO.Core.ISCSI.LUN",
      version: "1",
      method: "list",
    };

    let response = await this.do_request("GET", "entry.cgi", lun_list);
    return response.body.data.luns;
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

  async GetSnapshots() {
    let luns = await this.GetLuns();
    let snapshots = [];

    for (let lun of luns) {
      const get_snapshot_info = {
        api: "SYNO.Core.ISCSI.LUN",
        method: "list_snapshot",
        version: 1,
        src_lun_uuid: JSON.stringify(lun.uuid),
      };

      let response = await this.do_request(
        "GET",
        "entry.cgi",
        get_snapshot_info
      );

      snapshots = snapshots.concat(response.body.data.snapshots);
    }

    return snapshots;
  }

  async GetSnapshotByLunUUIDAndName(lun_uuid, name) {
    const get_snapshot_info = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "list_snapshot",
      version: 1,
      src_lun_uuid: JSON.stringify(lun_uuid),
    };

    let response = await this.do_request("GET", "entry.cgi", get_snapshot_info);

    if (response.body.data.snapshots) {
      let snapshot = response.body.data.snapshots.find((i) => {
        return i.description == name;
      });

      if (snapshot) {
        return snapshot;
      }
    }
  }

  async GetSnapshotByLunUUIDAndSnapshotUUID(lun_uuid, snapshot_uuid) {
    const get_snapshot_info = {
      api: "SYNO.Core.ISCSI.LUN",
      method: "list_snapshot",
      version: 1,
      src_lun_uuid: JSON.stringify(lun_uuid),
    };

    let response = await this.do_request("GET", "entry.cgi", get_snapshot_info);

    if (response.body.data.snapshots) {
      let snapshot = response.body.data.snapshots.find((i) => {
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
      if (err.synoCode === 18990538) {
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
      if (err.synoCode === 18990744) {
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
      //if (err.synoCode !== 18990710) {
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
      Object.assign({}, iscsi_lun_extend, {
        uuid: JSON.stringify(uuid),
        new_size: size,
      })
    );
  }

  async CreateClonedVolume(
    src_lun_uuid,
    dst_lun_name,
    dst_location,
    description
  ) {
    const create_cloned_volume = {
      api: "SYNO.Core.ISCSI.LUN",
      version: 1,
      method: "clone",
      src_lun_uuid: JSON.stringify(src_lun_uuid), // src lun uuid
      dst_lun_name: dst_lun_name, // dst lun name
      dst_location: dst_location,
      is_same_pool: true, // always true? string?
      clone_type: "democratic-csi", // check
    };
    if (description) {
      create_cloned_volume.description = description;
    }
    return await this.do_request("GET", "entry.cgi", create_cloned_volume);
  }

  async CreateVolumeFromSnapshot(
    src_lun_uuid,
    snapshot_uuid,
    cloned_lun_name,
    description
  ) {
    const create_volume_from_snapshot = {
      api: "SYNO.Core.ISCSI.LUN",
      version: 1,
      method: "clone_snapshot",
      src_lun_uuid: JSON.stringify(src_lun_uuid), // src lun uuid, snapshot id?
      snapshot_uuid: JSON.stringify(snapshot_uuid), // shaptop uuid
      cloned_lun_name: cloned_lun_name, // cloned lun name
      clone_type: "democratic-csi", // check
    };
    if (description) {
      create_volume_from_snapshot.description = description;
    }
    return await this.do_request(
      "GET",
      "entry.cgi",
      create_volume_from_snapshot
    );
  }
}

module.exports.SynologyHttpClient = SynologyHttpClient;
