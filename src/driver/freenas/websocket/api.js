const _ = require("lodash");
const semver = require("semver");
const { sleep, is_object } = require("../../../utils/general");
const { Zetabyte } = require("../../../utils/zfs");
const { Registry } = require("../../../utils/registry");

const __REGISTRY_NS__ = "FreeNASWebSocketApi";

const ERROR_DATASET_DOES_NOT_EXIST_REGEX = /PoolDataset.*does not exist/i;
const ERROR_SNAPSHOT_DOES_NOT_EXIST_REGEX = /PoolSnapshot.*does not exist/i;

class Api {
  constructor(client, options = {}) {
    this.client = client;
    this.options = options;
    this.registry = new Registry();
  }

  async getWebSocketClient() {
    return this.client;
  }

  /**
   * only here for the helpers
   * @returns
   */
  async getZetabyte() {
    return this.registry.get(`${__REGISTRY_NS__}:zb`, () => {
      return new Zetabyte({
        executor: {
          spawn: function () {
            throw new Error(
              "cannot use the zb implementation to execute zfs commands, must use the websocket api",
            );
          },
        },
      });
    });
  }

  normalizeResourceDomain(resource) {
    if (resource == "/sharing/cifs") {
      resource = "/sharing/smb";
    }

    // convert /sharing/nfs to sharing.nfs.query
    if (String(resource).startsWith("/")) {
      resource = resource.slice(1);
      if (resource.startsWith("services/")) {
        resource = resource.replace("services/", "");
      }
      resource = resource.replaceAll("/", ".");
      resource = resource.replace("targettoextent", "targetextent");
    }

    return resource;
  }
  async findResourceByProperties(resource, match) {
    if (!match) {
      return;
    }

    if (typeof match === "object" && Object.keys(match).length < 1) {
      return;
    }

    let method = this.normalizeResourceDomain(resource);
    method += ".query";

    const client = await this.getWebSocketClient();
    let target;
    let page = 0;
    let lastReponse;

    // loop and find target
    let queryParams = {};
    queryParams.limit = 100;
    queryParams.offset = 0;

    while (!target) {
      if (queryParams.hasOwnProperty("offset")) {
        queryParams.offset = queryParams.limit * page;
      }

      // crude stoppage attempt
      let response = await client.call(method, [[], queryParams]);
      if (lastReponse) {
        if (JSON.stringify(lastReponse) == JSON.stringify(response)) {
          break;
        }
      }
      lastReponse = response;

      response.some((i) => {
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

      if (response.length < queryParams.limit) {
        break;
      }

      page++;
    }

    return target;
  }

  async getSystemVersionMajorMinor() {
    const systemVersion = await this.getSystemVersion();
    let parts;
    let parts_i;
    let version = systemVersion;

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

  async getSystemVersion() {
    /**
     * FreeNAS-11.2-U5
     * TrueNAS-12.0-RELEASE
     * TrueNAS-SCALE-20.11-MASTER-20201127-092915
     * TrueNAS-26.0.0-BETA.3
     */
    let systemVersion = await this.client.systemVersion();
    if (!systemVersion) {
      throw new Error(
        `FreeNAS error getting system version info: websocket not connected`,
      );
    }

    return systemVersion;
  }

  async getSystemVersionSemver() {
    return semver.coerce(await this.getSystemVersionMajorMinor(), {
      loose: true,
    });
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
      arr.push({ key: property, value: String(properties[property]) });
    }

    return arr;
  }

  getPropertiesFromKeyValueArray(kvarr) {
    if (!Array.isArray(kvarr)) {
      return {};
    }

    let properties = {};

    for (const v of kvarr) {
      properties[v.key] = v.value;
    }

    return properties;
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

    for (const key in res) {
      const property = res[key];
      if (property.hasOwnProperty("raw")) {
        property.rawvalue = property.raw;
        delete property.raw;
      }

      if (is_object(property.source)) {
        let source = property.source;
        switch (source.type) {
          case "NONE":
            property.source = "-";
            break;
          case "LOCAL":
          case "INHERITED":
          case "DEFAULT":
            break;
          default:
            throw new Error(`unhanded source.type: ${source.type}`);
        }
      }
    }

    return res;
  }

  async ResourceList(resource, match) {
    let method = this.normalizeResourceDomain(resource);
    method += ".query";

    const client = await this.getWebSocketClient();
    let entries = [];
    let page = 0;
    let lastReponse;

    // loop and find target
    let queryParams = {};
    queryParams.limit = 100;
    queryParams.offset = 0;

    while (true) {
      if (queryParams.hasOwnProperty("offset")) {
        queryParams.offset = queryParams.limit * page;
      }

      // crude stoppage attempt
      let response = await client.call(method, [[], queryParams]);
      if (lastReponse) {
        if (JSON.stringify(lastReponse) == JSON.stringify(response)) {
          break;
        }
      }
      lastReponse = response;

      response.forEach((i) => {
        let isMatch = true;

        if (match) {
          if (typeof match === "function") {
            isMatch = match(i);
          } else {
            if (typeof match === "object" && Object.keys(match).length > 0) {
              for (let property in match) {
                if (match[property] != i[property]) {
                  isMatch = false;
                  break;
                }
              }
            }
          }
        }
        if (isMatch) {
          entries.push(i);
        }
      });

      if (response.length < queryParams.limit) {
        break;
      }

      page++;
    }

    return entries;
  }

  async ResourceDelete(resource, id, options = null) {
    let method = this.normalizeResourceDomain(resource);
    method += ".delete";

    const client = await this.getWebSocketClient();
    if (options) {
      return client.call(method, [parseInt(id), options]);
    } else {
      return client.call(method, [id]);
    }
  }

  async ResourceGet(resource, id, options = null) {
    let method = this.normalizeResourceDomain(resource);
    method += ".get_instance";

    id = parseInt(id);

    const client = await this.getWebSocketClient();
    if (options) {
      return client.call(method, [id, options]);
    } else {
      return client.call(method, [id]);
    }
  }

  async DatasetCreate(datasetName, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "pool.dataset.create";

    data.name = datasetName;

    try {
      await client.call(method, [data]);
      // TODO: remove this with appropriate versions of TN
      // https://ixsystems.atlassian.net/browse/NAS-144044
      let user_properties = this.getPropertiesFromKeyValueArray(
        data.user_properties,
      );
      await this.DatasetSet(datasetName, user_properties);
    } catch (err) {
      if (_.get(err, "message", "").includes("already exists")) return;
      throw err;
    }
  }

  /**
   *
   * @param {*} datasetName
   * @param {*} data
   * @returns
   */
  async DatasetDelete(datasetName, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "pool.dataset.delete";

    try {
      await client.call(method, [datasetName, data]);
    } catch (err) {
      if (_.get(err, "message", "").includes("does not exist")) return;
      throw err;
    }
  }

  async DatasetSet(datasetName, properties) {
    const client = await this.getWebSocketClient();
    let method = "pool.dataset.update";

    await client.call(method, [
      datasetName,
      {
        ...this.getSystemProperties(properties),
        user_properties_update: this.getPropertiesKeyValueArray(
          this.getUserProperties(properties),
        ),
      },
    ]);
  }

  async DatasetInherit(datasetName, property) {
    const client = await this.getWebSocketClient();
    let method = "pool.dataset.update";

    let system_properties = {};
    let user_properties_update = [];

    const isUserProperty = this.getIsUserProperty(property);
    if (isUserProperty) {
      user_properties_update = [{ key: property, remove: true }];
    } else {
      system_properties[property] = "INHERIT";
    }

    await client.call(method, [
      datasetName,
      {
        ...system_properties,
        user_properties_update,
      },
    ]);
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
    const client = await this.getWebSocketClient();
    let method = "pool.dataset.get_instance";
    let response;

    response = await client.call(method, [datasetName]);
    return this.normalizeProperties(response, properties);
  }

  /**
   *
   *
   * @param {*} datasetName
   * @returns
   */
  async DatasetGetResource(datasetName) {
    const client = await this.getWebSocketClient();
    let method = "pool.dataset.get_instance";
    let response;
    let options = {
      extra: {
        snapshots: true,
        // user_properties do not come out of this call currently
        snapshots_properties: ["creation", "foo:bar"],
      },
    };
    options = {};

    response = await client.call(method, [datasetName, options]);
    return response;
  }

  async DatasetGetSnapshots(datasetName, properties = []) {
    const client = await this.getWebSocketClient();
    let method = "zfs.resource.snapshot.query";
    let response;

    let data = {};
    data.paths = [datasetName];
    data.get_user_properties = true;
    data.get_source = true;
    data.properties = properties;
    data.recursive = true;

    //method = "pool.snapshot.get_instance";
    //response = await client.call(method, [datasetName]);

    try {
      response = await client.call(method, [data]);
      return response;
    } catch (err) {
      // return empty set of snapshots for datasets which do not exist
      if (_.get(err, "message", "").includes("not found")) return [];
      throw err;
    }

    //return this.normalizeProperties(response[0], properties);
  }

  async DatasetGetDatasets(datasetName, properties = []) {
    const client = await this.getWebSocketClient();
    let method = "zfs.resource.query";
    let response;

    let data = {};
    data.paths = [datasetName];
    data.get_user_properties = true;
    data.get_source = true;
    data.properties = properties;
    //data.recursive = true;
    data.nest_results = false;
    data.get_children = true;

    //method = "pool.snapshot.get_instance";
    //response = await client.call(method, [datasetName]);

    try {
      response = await client.call(method, [data]);
      return response;
    } catch (err) {
      // return empty set of snapshots for datasets which do not exist
      if (_.get(err, "message", "").includes("not found")) return [];
      throw err;
    }

    //return this.normalizeProperties(response[0], properties);
  }

  async DatasetDestroySnapshots(datasetName, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "zfs.resource.snapshot.destroy";
    data.path = datasetName;

    await client.call(method, [{ ...data, all_snapshots: true }]);
  }

  async SnapshotSet(snapshotName, properties) {
    const client = await this.getWebSocketClient();
    let method = "pool.snapshot.update";

    await client.call(method, [
      snapshotName,
      {
        ...this.getSystemProperties(properties),
        user_properties_update: this.getPropertiesKeyValueArray(
          this.getUserProperties(properties),
        ),
      },
    ]);
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
    const client = await this.getWebSocketClient();
    let method = "zfs.resource.snapshot.query";
    let response;

    let data = {};
    data.paths = [snapshotName];
    data.get_user_properties = true;
    data.get_source = true;
    data.properties = properties;

    response = await client.call(method, [data]);
    if (response.length != 1)
      throw new Error(`PoolSnapshot ${snapshotName} does not exist`);

    // [ENOENT] zfs.resource.snapshot.query: 'tank/k8s/test/PVC-111@testsnapshot' not found

    return this.normalizeProperties(response[0], properties);
    //return response[0];
  }

  async SnapshotCreate(snapshotName, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "zfs.resource.snapshot.create";

    const zb = await this.getZetabyte();
    const dataset = zb.helpers.extractDatasetName(snapshotName);
    const snapshot = zb.helpers.extractSnapshotName(snapshotName);

    data.dataset = dataset;
    data.name = snapshot;

    // NOTE: the user properties are simply sent as normal key/value pairs in data.user_properties if needed
    // NOTE: standard properties cannot be set on a snapshot at creation time
    if (data.properties) {
      if (Object.keys(data.properties).length > 0) {
        data.user_properties = this.getUserProperties(data.properties);

        if (
          Object.keys(data.properties).length !=
          Object.keys(data.user_properties).length
        ) {
          console.log(
            "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            data.properties,
            data.user_properties,
          );
          throw new Error("sending invalid properties to call");
        }
      }

      // field is not valid for this call
      delete data.properties;
    }

    try {
      await client.call(method, [data]);
    } catch (err) {
      if (String(err.message).includes("already exists")) return;
      throw err;
    }
  }

  async SnapshotDelete(snapshotName, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "zfs.resource.snapshot.destroy";

    data.path = snapshotName;

    try {
      await client.call(method, [data]);
    } catch (err) {
      if (String(err.message).includes("not found")) return;
      throw err;
    }
  }

  async NfsShareDelete(shareId) {
    const client = await this.getWebSocketClient();
    let method = "sharing.nfs.delete";

    try {
      await client.call(method, [parseInt(shareId)]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  async NfsShareCreate(share) {
    const client = await this.getWebSocketClient();
    let method = "sharing.nfs.create";

    try {
      return await client.call(method, [share]);
    } catch (err) {
      throw err;
    }
  }

  async SmbShareDelete(shareId) {
    const client = await this.getWebSocketClient();
    let method = "sharing.smb.delete";

    try {
      await client.call(method, [parseInt(shareId)]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  async SmbShareCreate(share) {
    const client = await this.getWebSocketClient();
    let method = "sharing.smb.create";

    try {
      return await client.call(method, [share]);
    } catch (err) {
      throw err;
    }
  }

  async IscsiGlobalConfigGet() {
    const client = await this.getWebSocketClient();
    let method = "iscsi.global.config";

    return await client.call(method, []);
  }

  async IscsiTargetCreate(target) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.target.create";

    return client.call(method, [target]);
  }

  async IscsiTargetUpdate(targetId, data) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.target.update";

    targetId = parseInt(targetId);

    return client.call(method, [targetId, data]);
  }

  async IscsiTargetDelete(targetId) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.target.delete";

    targetId = parseInt(targetId);
    let force = false;
    let delete_extents = false;

    try {
      await client.call(method, [targetId, force, delete_extents]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  async IscsiExtentCreate(extent) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.extent.create";

    return client.call(method, [extent]);
  }

  async IscsiExtentUpdate(extentId, data) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.extent.update";

    extentId = parseInt(extentId);

    return client.call(method, [extentId, data]);
  }

  async IscsiExtentDelete(extentId) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.extent.delete";

    extentId = parseInt(extentId);
    // remove backing file if file-based extent
    let remove = false;
    let force = false;

    try {
      await client.call(method, [extentId, remove, force]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  async IscsiTargetExtentCreate(te) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.targetextent.create";

    return client.call(method, [te]);
  }

  async IscsiTargetExtentUpdate(id, data) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.targetextent.update";

    id = parseInt(id);

    return client.call(method, [id, data]);
  }

  async IscsiTargetExtentDelete(id) {
    const client = await this.getWebSocketClient();
    let method = "iscsi.targetextent.delete";

    id = parseInt(id);
    let force = false;

    try {
      await client.call(method, [id, force]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  async NvmetGlobalConfigGet() {
    const client = await this.getWebSocketClient();
    let method = "nvmet.global.config";

    return await client.call(method, []);
  }

  async NvmetSubsysCreate(subsys) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.subsys.create";

    subsys.allow_any_host = true;

    return client.call(method, [subsys]);
  }

  async NvmetSubsysUpdate(subsysId, data) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.subsys.update";

    subsysId = parseInt(subsysId);

    return client.call(method, [subsysId, data]);
  }

  async NvmetSubsysDelete(subsysId, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.subsys.delete";

    subsysId = parseInt(subsysId);
    if (!data.hasOwnProperty("force")) {
      data.force = false;
    }

    try {
      await client.call(method, [subsysId, data]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  NvmetNamespaceZvolPathNormalized(zvol) {
    zvol = String(zvol);
    if (zvol.startsWith("/dev/")) {
      zvol = zvol.substring(5);
    }

    if (zvol.startsWith("/")) {
      zvol = zvol.substring(1);
    }

    if (!zvol.startsWith("zvol/")) {
      zvol = `zvol/${zvol}`;
    }

    return zvol;
  }
  async NvmetNamespaceCreate(ns) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.namespace.create";

    if (ns.device_type == "ZVOL") {
      ns.device_path = this.NvmetNamespaceZvolPathNormalized(ns.device_path);
    }

    return client.call(method, [ns]);
  }

  async NvmetNamespaceUpdate(nsId, data) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.namespace.update";

    nsId = parseInt(nsId);

    return client.call(method, [nsId, data]);
  }

  async NvmetNamespaceDelete(nsId, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.namespace.delete";

    nsId = parseInt(nsId);
    // remove underlying file if device_type is file
    if (!data.hasOwnProperty("remove")) {
      data.remove = false;
    }

    try {
      await client.call(method, [nsId, data]);
    } catch (err) {
      if (String(err.message).includes("does not exist")) return;
      throw err;
    }
  }

  async NvmetPortSubsysCreate(port_id, subsys_id) {
    const client = await this.getWebSocketClient();
    let method = "nvmet.port_subsys.create";

    let response;

    let data = {
      port_id,
      subsys_id,
    };

    try {
      return await client.call(method, [data]);
    } catch (err) {
      if (String(err.message).includes("already exists")) {
        response = await this.findResourceByProperties(
          "nvmet.port_subsys",
          (item) => {
            if (item.port.id == port_id && item.subsys.id == subsys_id) {
              return true;
            }
            return false;
          },
        );
      }
      if (response) {
        return response;
      }
      throw err;
    }
  }

  async CloneCreate(snapshotName, datasetName, data = {}) {
    const client = await this.getWebSocketClient();
    let method = "pool.snapshot.clone";

    data.snapshot = snapshotName;
    data.dataset_dst = datasetName;
    let system_properties = {};
    let user_properties = {};
    if (Object.keys(data.dataset_properties).length > 0) {
      system_properties = this.getSystemProperties(data.dataset_properties);
      user_properties = this.getUserProperties(data.dataset_properties);
      data.dataset_properties = system_properties;
    }

    try {
      await client.call(method, [data]);

      // update user properties
      if (Object.keys(user_properties).length > 0) {
        await this.DatasetSet(datasetName, user_properties);
      }
    } catch (err) {
      if (String(err.message).includes("already exists")) return;
      throw err;
    }
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
    const client = await this.getWebSocketClient();
    let method = "replication.run_onetime";

    return client.call(method, [data]);
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
    // TODO: this can technically be improved to listen to job events over the socket instead of polling
    // state = SUCCESS/ABORTED/FAILED means finality has been reached
    // state = RUNNING
    do {
      currentTime = Date.now() / 1000;
      if (timeout > 0 && currentTime > startTime + timeout) {
        throw new Error("timeout waiting for job to complete");
      }

      if (job) {
        await sleep(check_interval);
      }

      job = await this.CoreGetJob(job_id);
    } while (!["SUCCESS", "ABORTED", "FAILED"].includes(job.state));

    return job;
  }

  async CoreGetJob(job_id) {
    let job;
    job = await this.CoreGetJobs([["id", "=", job_id]]);
    job = job[0];

    return job;
  }

  async CoreGetJobs(data) {
    const client = await this.getWebSocketClient();
    let method = "core.get_jobs";

    return client.call(method, [data]);
  }

  /**
   *
   * @param {*} data
   */
  async FilesystemSetperm(data) {
    // {
    //   "path": "string",
    //   "mode": "string",
    //   "uid": 0,
    //   "gid": 0,
    //   "options": {
    //     "stripacl": false,
    //     "recursive": false,
    //     "traverse": false
    //   }
    // }

    const client = await this.getWebSocketClient();
    let method = "filesystem.setperm";

    return client.call(method, [data]);
  }

  /**
   *
   * @param {*} data
   */
  async FilesystemChown(data) {
    // {
    //   "path": "string",
    //   "uid": 0,
    //   "gid": 0,
    //   "options": {
    //     "recursive": false,
    //     "traverse": false
    //   }
    // }

    const client = await this.getWebSocketClient();
    let method = "filesystem.chown";

    return client.call(method, [data]);
  }

  async call(method, params) {
    const client = await this.getWebSocketClient();
    return client.call(method, params);
  }
}

module.exports.Api = Api;
module.exports.ERROR_DATASET_DOES_NOT_EXIST_REGEX =
  ERROR_DATASET_DOES_NOT_EXIST_REGEX;
module.exports.ERROR_SNAPSHOT_DOES_NOT_EXIST_REGEX =
  ERROR_SNAPSHOT_DOES_NOT_EXIST_REGEX;
