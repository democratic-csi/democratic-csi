const _ = require("lodash");
const axios = require("axios");
const crypto = require("crypto");
const dns = require("dns");
const crc = require("crc");

axios.interceptors.request.use(
  function (config) {
    config.metadata = { startTime: new Date() };
    return config;
  },
  function (error) {
    return Promise.reject(error);
  }
);

axios.interceptors.response.use(
  function (response) {
    response.config.metadata.endTime = new Date();
    response.duration =
      response.config.metadata.endTime - response.config.metadata.startTime;
    return response;
  },
  function (error) {
    error.config.metadata.endTime = new Date();
    error.duration =
      error.config.metadata.endTime - error.config.metadata.startTime;
    return Promise.reject(error);
  }
);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function trimchar(str, ch) {
  var start = 0,
    end = str.length;

  while (start < end && str[start] === ch) ++start;

  while (end > start && str[end - 1] === ch) --end;

  return start > 0 || end < str.length ? str.substring(start, end) : str;
}

function md5(val) {
  return crypto.createHash("md5").update(val).digest("hex");
}

function crc8(data) {
  return crc.crc8(data);
}

function crc16(data) {
  return crc.crc16(data);
}

function crc32(data) {
  return crc.crc32(data);
}

function lockKeysFromRequest(call, serviceMethodName) {
  switch (serviceMethodName) {
    // controller
    case "CreateVolume":
      return ["create_volume_name_" + call.request.name];
    case "DeleteVolume":
    case "ControllerExpandVolume":
      return ["volume_id_" + call.request.volume_id];
    case "CreateSnapshot":
      return [
        "create_snapshot_name_" + call.request.name,
        "volume_id_" + call.request.source_volume_id,
      ];
    case "DeleteSnapshot":
      return ["snapshot_id_" + call.request.snapshot_id];

    // node
    case "NodeStageVolume":
    case "NodeUnstageVolume":
    case "NodePublishVolume":
    case "NodeUnpublishVolume":
    case "NodeExpandVolume":
      return ["volume_id_" + call.request.volume_id];

    case "NodeGetVolumeStats":
    default:
      return [];
  }
}

function getLargestNumber() {
  let number;
  for (let i = 0; i < arguments.length; i++) {
    value = Number(arguments[i]);
    if (isNaN(value)) {
      continue;
    }
    if (isNaN(number)) {
      number = value;
      continue;
    }
    number = value > number ? value : number;
  }

  return number;
}

function stripWindowsDriveLetter(path) {
  return path.replace(/^[a-zA-Z]:/, "");
}

function hasWindowsDriveLetter(path) {
  return /^[a-zA-Z]:/i.test(path);
}

/**
 * transition function to replicate `request` style requests using axios
 *
 * @param {*} options
 * @param {*} callback
 */
function axios_request(options, callback = function () {}) {
  function prep_response(res) {
    res["statusCode"] = res["status"];
    delete res["status"];

    res["body"] = res["data"];
    delete res["data"];

    return res;
  }

  axios(options)
    .then((res) => {
      res = prep_response(res);
      callback(null, res, res.body);
    })
    .catch((err) => {
      if (err.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        let res = prep_response(err.response);
        let senderr = false;
        if (
          options.validateStatus &&
          typeof options.validateStatus == "function"
        ) {
          senderr = true;
        }
        callback(senderr ? err : null, res, res.body);
      } else if (err.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        callback(err, null, null);
      } else {
        // Something happened in setting up the request that triggered an Error
        callback(err, null, null);
      }
    });
}

function stringify(value) {
  const getCircularReplacer = () => {
    const seen = new WeakSet();
    return (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return;
        }
        seen.add(value);
      }
      return value;
    };
  };

  return JSON.stringify(value, getCircularReplacer());
}

function default_supported_block_filesystems() {
  return ["btrfs", "exfat", "ext3", "ext4", "ext4dev", "ntfs", "vfat", "xfs"];
}

function default_supported_file_filesystems() {
  return ["nfs", "cifs"];
}

async function retry(retries, retriesDelay, code, options = {}) {
  let current_try = 0;
  let maxwait = _.get(options, "maxwait");
  let logerrors = _.get(options, "logerrors", false);
  let retryCondition = options.retryCondition;
  let executeStartTime;

  do {
    current_try++;
    try {
      executeStartTime = Date.now();
      return await code();
    } catch (err) {
      if (current_try >= retries) {
        throw err;
      }
      if (retryCondition) {
        let retry = retryCondition(err);
        if (!retry) {
          console.log(`retry - failed condition, not trying again`);
          //console.log(code.toString(), retryCondition.toString());
          throw err;
        }
      }
      if (logerrors === true) {
        console.log(`retry - err:`, err);
      }
    }

    // handle minExecutionTime
    if (options.minExecutionTime > 0) {
      let executionElapsedTIme = Date.now() - executeStartTime;
      let minExecutionDelayTime =
        options.minExecutionTime - executionElapsedTIme;
      if (minExecutionDelayTime > 0) {
        await sleep(minExecutionDelayTime);
      }
    }

    // handle delay
    let sleep_time = retriesDelay;
    if (_.get(options, "exponential", false) === true) {
      sleep_time = retriesDelay * current_try;
    }

    if (maxwait) {
      if (sleep_time > maxwait) {
        sleep_time = maxwait;
      }
    }
    if (sleep_time > 0) {
      console.log(`retry - waiting ${sleep_time}ms before trying again`);
      await sleep(sleep_time);
    }
  } while (true);
}

async function hostname_lookup(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, function (err, result) {
      if (err) {
        return reject(err);
      }

      return resolve(result);
    });
  });
}

module.exports.sleep = sleep;
module.exports.md5 = md5;
module.exports.crc32 = crc32;
module.exports.crc16 = crc16;
module.exports.crc8 = crc8;
module.exports.lockKeysFromRequest = lockKeysFromRequest;
module.exports.getLargestNumber = getLargestNumber;
module.exports.stringify = stringify;
module.exports.stripWindowsDriveLetter = stripWindowsDriveLetter;
module.exports.hasWindowsDriveLetter = hasWindowsDriveLetter;
module.exports.axios_request = axios_request;
module.exports.default_supported_block_filesystems =
  default_supported_block_filesystems;
module.exports.default_supported_file_filesystems =
  default_supported_file_filesystems;
module.exports.retry = retry;
module.exports.trimchar = trimchar;
module.exports.hostname_lookup = hostname_lookup;
