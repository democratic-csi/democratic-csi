
const { sleep, stringify } = require("../../../utils/general");
const { Zetabyte } = require("../../../utils/zfs");

// used for in-memory cache of the version info
const FREENAS_SYSTEM_VERSION_CACHE_KEY = "freenas:system_version";
const __REGISTRY_NS__ = "FreeNASHttpApi";

class Api {
  constructor(client, cache, options = {}) {
    this.client = client;
    this.cache = cache;
    this.options = options;
  }

  async getHttpClient() {
    return this.client;
  }

  /**
   * only here for the helpers
   * @returns
   */
  async getZetabyte() {
    return this.ctx.registry.get(`${__REGISTRY_NS__}:zb`, () => {
      return new Zetabyte({
        executor: {
          spawn: function () {
            throw new Error(
              "cannot use the zb implementation to execute zfs commands, must use the http api"
            );
          },
        },
      });
    });
  }

  async findResourceByProperties(endpoint, match) {
    if (!match) {
      return;
    }

    if (typeof match === "object" && Object.keys(match).length < 1) {
      return;
    }

    const httpClient = await this.getHttpClient();
    let target;
    let page = 0;
    let lastReponse;

    // loop and find target
    let queryParams = {};
    queryParams.limit = 100;
    queryParams.offset = 0;

    while (!target) {
      //Content-Range: items 0-2/3 (full set)
      //Content-Range: items 0--1/3 (invalid offset)
      if (queryParams.hasOwnProperty("offset")) {
        queryParams.offset = queryParams.limit * page;
      }

      // crude stoppage attempt
      let response = await httpClient.get(endpoint, queryParams);
      if (lastReponse) {
        if (JSON.stringify(lastReponse) == JSON.stringify(response)) {
          break;
        }
      }
      lastReponse = response;

      if (response.statusCode == 200) {
        if (response.body.length < 1) {
          break;
        }
        response.body.some((i) => {
          let isMatch = true;

          if (typeof match === "function") {
            isMatch = match(i);
          } else {
            for (let property in match) {
              if (match[property] != i[property]) {
                isMatch = false;
                break;
              }
            }
          }

          if (isMatch) {
            target = i;
            return true;
          }

          return false;
        });
      } else {
        throw new Error(
          "FreeNAS http error - code: " +
            response.statusCode +
            " body: " +
            JSON.stringify(response.body)
        );
      }
      page++;
    }

    return target;
  }

  async getApiVersion() {
    const systemVersion = await this.getSystemVersion();

    if (systemVersion.v2) {
      if ((await this.getSystemVersionMajorMinor()) == 11.2) {
        return 1;
      }
      return 2;
    }

    if (systemVersion.v1) {
      return 1;
    }

    return 2;
  }

  async getIsFreeNAS() {
    const systemVersion = await this.getSystemVersion();
    let version;

    if (systemVersion.v2) {
      version = systemVersion.v2;
    } else {
      version = systemVersion.v1.fullversion;
    }

    if (version.toLowerCase().includes("freenas")) {
      return true;
    }

    return false;
  }

  async getIsTrueNAS() {
    const systemVersion = await this.getSystemVersion();
    let version;

    if (systemVersion.v2) {
      version = systemVersion.v2;
    } else {
      version = systemVersion.v1.fullversion;
    }

    if (version.toLowerCase().includes("truenas")) {
      return true;
    }

    return false;
  }

  async getIsScale() {
    const systemVersion = await this.getSystemVersion();

    if (systemVersion.v2 && systemVersion.v2.toLowerCase().includes("scale")) {
      return true;
    }

    return false;
  }

  async getSystemVersionMajorMinor() {
    const systemVersion = await this.getSystemVersion();
    let parts;
    let parts_i;
    let version;

    /*
    systemVersion.v2 = "FreeNAS-11.2-U5";
    systemVersion.v2 = "TrueNAS-SCALE-20.11-MASTER-20201127-092915";
    systemVersion.v1 = {
      fullversion: "FreeNAS-9.3-STABLE-201503200528",
      fullversion: "FreeNAS-11.2-U5 (c129415c52)",
    };

    systemVersion.v2 = null;
    */

    if (systemVersion.v2) {
      version = systemVersion.v2;
    } else {
      version = systemVersion.v1.fullversion;
    }

    if (version) {
      parts = version.split("-");
      parts_i = [];
      parts.forEach((value) => {
        let i = value.replace(/[^\d.]/g, "");
        if (i.length > 0) {
          parts_i.push(i);
        }
      });

      // join and resplit to deal with single elements which contain a decimal
      parts_i = parts_i.join(".").split(".");
      parts_i.splice(2);
      return parts_i.join(".");
    }
  }

  async getSystemVersionMajor() {
    const majorMinor = await this.getSystemVersionMajorMinor();
    return majorMinor.split(".")[0];
  }

  async setVersionInfoCache(versionInfo) {
    await this.cache.set(FREENAS_SYSTEM_VERSION_CACHE_KEY, versionInfo, {
      ttl: 60 * 1000,
    });
  }

  async getSystemVersion() {
    let cacheData = await this.cache.get(FREENAS_SYSTEM_VERSION_CACHE_KEY);

    if (cacheData) {
      return cacheData;
    }

    const httpClient = await this.getHttpClient(false);
    const endpoint = "/system/version/";
    let response;
    const startApiVersion = httpClient.getApiVersion();
    const versionInfo = {};
    const versionErrors = {};
    const versionResponses = {};

    httpClient.setApiVersion(2);
    /**
     * FreeNAS-11.2-U5
     * TrueNAS-12.0-RELEASE
     * TrueNAS-SCALE-20.11-MASTER-20201127-092915
     */
    try {
      response = await httpClient.get(endpoint, null, { timeout: 5 * 1000 });
      versionResponses.v2 = response;
      if (response.statusCode == 200) {
        versionInfo.v2 = response.body;

        // return immediately to save on resources and silly requests
        await this.setVersionInfoCache(versionInfo);

        // reset apiVersion
        httpClient.setApiVersion(startApiVersion);

        return versionInfo;
      }
    } catch (e) {
      // if more info is needed use e.stack
      versionErrors.v2 = e.toString();
    }

    httpClient.setApiVersion(1);
    /**
     * {"fullversion": "FreeNAS-9.3-STABLE-201503200528", "name": "FreeNAS", "version": "9.3"}
     * {"fullversion": "FreeNAS-11.2-U5 (c129415c52)", "name": "FreeNAS", "version": ""}
     */
    try {
      response = await httpClient.get(endpoint, null, { timeout: 5 * 1000 });
      versionResponses.v1 = response;
      if (response.statusCode == 200 && IsJsonString(response.body)) {
        versionInfo.v1 = response.body;
        await this.setVersionInfoCache(versionInfo);

        // reset apiVersion
        httpClient.setApiVersion(startApiVersion);

        return versionInfo;
      }
    } catch (e) {
      // if more info is needed use e.stack
      versionErrors.v1 = e.toString();
    }

    // throw error if cannot get v1 or v2 data
    // likely bad creds/url
    throw new Error(
      `FreeNAS error getting system version info: ${stringify({
        errors: versionErrors,
        responses: versionResponses,
      })}`
    );
  }

  getIsUserProperty(property) {
    if (property.includes(":")) {
      return true;
    }
    return false;
  }

  getUserProperties(properties) {
    let user_properties = {};
    for (const property in properties) {
      if (this.getIsUserProperty(property)) {
        user_properties[property] = properties[property];
      }
    }

    return user_properties;
  }

  getSystemProperties(properties) {
    let system_properties = {};
    for (const property in properties) {
      if (!this.getIsUserProperty(property)) {
        system_properties[property] = properties[property];
      }
    }

    return system_properties;
  }

  getPropertiesKeyValueArray(properties) {
    let arr = [];
    for (const property in properties) {
      arr.push({ key: property, value: properties[property] });
    }

    return arr;
  }

  normalizeProperties(dataset, properties) {
    let res = {};
    for (const property of properties) {
      let p;
      if (dataset.hasOwnProperty(property)) {
        p = dataset[property];
      } else if (
        dataset.properties &&
        dataset.properties.hasOwnProperty(property)
      ) {
        p = dataset.properties[property];
      } else if (
        dataset.user_properties &&
        dataset.user_properties.hasOwnProperty(property)
      ) {
        p = dataset.user_properties[property];
      } else {
        p = {
          value: "-",
          rawvalue: "-",
          source: "-",
        };
      }

      if (typeof p === "object" && p !== null) {
        // nothing, leave as is
      } else {
        p = {
          value: p,
          rawvalue: p,
          source: "-",
        };
      }

      res[property] = p;
    }

    return res;
  }

  async DatasetCreate(datasetName, data) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    data.name = datasetName;

    endpoint = "/pool/dataset";
    response = await httpClient.post(endpoint, data);

    if (response.statusCode == 200) {
      return;
    }

    if (
      response.statusCode == 422 &&
      JSON.stringify(response.body).includes("already exists")
    ) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  /**
   *
   * @param {*} datasetName
   * @param {*} data
   * @returns
   */
  async DatasetDelete(datasetName, data) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/pool/dataset/id/${encodeURIComponent(datasetName)}`;
    response = await httpClient.delete(endpoint, data);

    if (response.statusCode == 200) {
      return;
    }

    if (
      response.statusCode == 422 &&
      JSON.stringify(response.body).includes("does not exist")
    ) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  async DatasetSet(datasetName, properties) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/pool/dataset/id/${encodeURIComponent(datasetName)}`;
    response = await httpClient.put(endpoint, {
      ...this.getSystemProperties(properties),
      user_properties_update: this.getPropertiesKeyValueArray(
        this.getUserProperties(properties)
      ),
    });

    if (response.statusCode == 200) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  async DatasetInherit(datasetName, property) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;
    let system_properties = {};
    let user_properties_update = [];

    const isUserProperty = this.getIsUserProperty(property);
    if (isUserProperty) {
      user_properties_update = [{ key: property, remove: true }];
    } else {
      system_properties[property] = "INHERIT";
    }

    endpoint = `/pool/dataset/id/${encodeURIComponent(datasetName)}`;
    response = await httpClient.put(endpoint, {
      ...system_properties,
      user_properties_update,
    });

    if (response.statusCode == 200) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  /**
   *
   * zfs get -Hp all tank/k8s/test/PVC-111
   *
   * @param {*} datasetName
   * @param {*} properties
   * @returns
   */
  async DatasetGet(datasetName, properties) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/pool/dataset/id/${encodeURIComponent(datasetName)}`;
    response = await httpClient.get(endpoint);

    if (response.statusCode == 200) {
      return this.normalizeProperties(response.body, properties);
    }

    if (response.statusCode == 404) {
      throw new Error("dataset does not exist");
    }

    throw new Error(JSON.stringify(response.body));
  }

  async DatasetDestroySnapshots(datasetName, data = {}) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    data.name = datasetName;

    endpoint = "/pool/dataset/destroy_snapshots";
    response = await httpClient.post(endpoint, data);

    if (response.statusCode == 200) {
      return response.body;
    }

    if (
      response.statusCode == 422 &&
      JSON.stringify(response.body).includes("already exists")
    ) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  async SnapshotSet(snapshotName, properties) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/zfs/snapshot/id/${encodeURIComponent(snapshotName)}`;
    response = await httpClient.put(endpoint, {
      //...this.getSystemProperties(properties),
      user_properties_update: this.getPropertiesKeyValueArray(
        this.getUserProperties(properties)
      ),
    });

    if (response.statusCode == 200) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  /**
   *
   * zfs get -Hp all tank/k8s/test/PVC-111
   *
   * @param {*} snapshotName
   * @param {*} properties
   * @returns
   */
  async SnapshotGet(snapshotName, properties) {
    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/zfs/snapshot/id/${encodeURIComponent(snapshotName)}`;
    response = await httpClient.get(endpoint);

    if (response.statusCode == 200) {
      return this.normalizeProperties(response.body, properties);
    }

    if (response.statusCode == 404) {
      throw new Error("dataset does not exist");
    }

    throw new Error(JSON.stringify(response.body));
  }

  async SnapshotCreate(snapshotName, data = {}) {
    const httpClient = await this.getHttpClient(false);
    const zb = await this.getZetabyte();

    let response;
    let endpoint;

    const dataset = zb.helpers.extractDatasetName(snapshotName);
    const snapshot = zb.helpers.extractSnapshotName(snapshotName);

    data.dataset = dataset;
    data.name = snapshot;

    endpoint = "/zfs/snapshot";
    response = await httpClient.post(endpoint, data);

    if (response.statusCode == 200) {
      return;
    }

    if (
      response.statusCode == 422 &&
      JSON.stringify(response.body).includes("already exists")
    ) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  async SnapshotDelete(snapshotName, data = {}) {
    const httpClient = await this.getHttpClient(false);
    const zb = await this.getZetabyte();

    let response;
    let endpoint;

    endpoint = `/zfs/snapshot/id/${encodeURIComponent(snapshotName)}`;
    response = await httpClient.delete(endpoint, data);

    if (response.statusCode == 200) {
      return;
    }

    if (response.statusCode == 404) {
      return;
    }

    if (
      response.statusCode == 422 &&
      JSON.stringify(response.body).includes("not found")
    ) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  async CloneCreate(snapshotName, datasetName, data = {}) {
    const httpClient = await this.getHttpClient(false);
    const zb = await this.getZetabyte();

    let response;
    let endpoint;

    data.snapshot = snapshotName;
    data.dataset_dst = datasetName;

    endpoint = "/zfs/snapshot/clone";
    response = await httpClient.post(endpoint, data);

    if (response.statusCode == 200) {
      return;
    }

    if (
      response.statusCode == 422 &&
      JSON.stringify(response.body).includes("already exists")
    ) {
      return;
    }

    throw new Error(JSON.stringify(response.body));
  }

  // get all dataset snapshots
  // https://github.com/truenas/middleware/pull/6934
  // then use core.bulk to delete all

  /**
   *
   * /usr/lib/python3/dist-packages/middlewared/plugins/replication.py
   * readonly enum=["SET", "REQUIRE", "IGNORE"]
   *
   * @param {*} data
   * @returns
   */
  async ReplicationRunOnetime(data) {
    const httpClient = await this.getHttpClient(false);

    let response;
    let endpoint;

    endpoint = "/replication/run_onetime";
    response = await httpClient.post(endpoint, data);

    // 200 means the 'job' was accepted only
    // must continue to check the status of the job to know when it has finished and if it was successful
    // /core/get_jobs [["id", "=", jobidhere]]
    if (response.statusCode == 200) {
      return response.body;
    }

    throw new Error(JSON.stringify(response.body));
  }

  /**
   *
   * @param {*} job_id
   * @param {*} timeout in seconds
   * @returns
   */
  async CoreWaitForJob(job_id, timeout = 0, check_interval = 3000) {
    if (!job_id) {
      throw new Error("invalid job_id");
    }

    const startTime = Date.now() / 1000;
    let currentTime;

    let job;

    // wait for job to finish
    do {
      currentTime = Date.now() / 1000;
      if (timeout > 0 && currentTime > startTime + timeout) {
        throw new Error("timeout waiting for job to complete");
      }

      if (job) {
        await sleep(check_interval);
      }
      job = await this.CoreGetJobs({ id: job_id });
      job = job[0];
    } while (!["SUCCESS", "ABORTED", "FAILED"].includes(job.state));

    return job;
  }

  async CoreGetJobs(data) {
    const httpClient = await this.getHttpClient(false);

    let response;
    let endpoint;

    endpoint = "/core/get_jobs";
    response = await httpClient.get(endpoint, data);

    // 200 means the 'job' was accepted only
    // must continue to check the status of the job to know when it has finished and if it was successful
    // /core/get_jobs [["id", "=", jobidhere]]
    // state = SUCCESS/ABORTED/FAILED means finality has been reached
    // state = RUNNING
    if (response.statusCode == 200) {
      return response.body;
    }

    throw new Error(JSON.stringify(response.body));
  }

  /**
   *
   * @param {*} data
   */
  async FilesystemSetperm(data) {
    /*
      {
        "path": "string",
        "mode": "string",
        "uid": 0,
        "gid": 0,
        "options": {
          "stripacl": false,
          "recursive": false,
          "traverse": false
        }
      }
    */

    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/filesystem/setperm`;
    response = await httpClient.post(endpoint, data);

    if (response.statusCode == 200) {
      return response.body;
    }

    throw new Error(JSON.stringify(response.body));
  }

  /**
   *
   * @param {*} data
   */
  async FilesystemChown(data) {
    /*
        {
          "path": "string",
          "uid": 0,
          "gid": 0,
          "options": {
            "recursive": false,
            "traverse": false
          }
        }
      */

    const httpClient = await this.getHttpClient(false);
    let response;
    let endpoint;

    endpoint = `/filesystem/chown`;
    response = await httpClient.post(endpoint, data);

    if (response.statusCode == 200) {
      return response.body;
    }

    throw new Error(JSON.stringify(response.body));
  }
}

function IsJsonString(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}

module.exports.Api = Api;
