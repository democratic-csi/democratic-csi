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

module.exports.sleep = sleep;
module.exports.lockKeysFromRequest = lockKeysFromRequest;
