function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    case "NodeGetVolumeStats":
    case "NodeExpandVolume":
      return ["volume_id_" + call.request.volume_id];

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

module.exports.sleep = sleep;
module.exports.lockKeysFromRequest = lockKeysFromRequest;
module.exports.getLargestNumber = getLargestNumber;
module.exports.stringify = stringify;