const { ControllerZfsSshBaseDriver } = require("../controller-zfs-ssh");
const { GrpcError, grpc } = require("../../utils/grpc");

const Handlebars = require("handlebars");

class ControllerZfsGenericDriver extends ControllerZfsSshBaseDriver {
  /**
   * cannot make this a storage class parameter as storage class/etc context is *not* sent
   * into various calls such as GetControllerCapabilities etc
   */
  getDriverZfsResourceType() {
    switch (this.options.driver) {
      case "zfs-generic-nfs":
        return "filesystem";
      case "zfs-generic-iscsi":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  /**
   * should create any necessary share resources
   * should set the SHARE_VOLUME_CONTEXT_PROPERTY_NAME propery
   *
   * @param {*} datasetName
   */
  async createShare(call, datasetName) {
    const zb = this.getZetabyte();
    const sshClient = this.getSshClient();

    let properties;
    let response;
    let share = {};
    let volume_context = {};

    switch (this.options.driver) {
      case "zfs-generic-nfs":
        switch (this.options.nfs.shareStrategy) {
          case "setDatasetProperties":
            for (let key of ["share", "sharenfs"]) {
              if (
                this.options.nfs.shareStrategySetDatasetProperties.properties[
                  key
                ]
              ) {
                await zb.zfs.set(datasetName, {
                  [key]: this.options.nfs.shareStrategySetDatasetProperties
                    .properties[key],
                });
              }
            }

            break;
          default:
            break;
        }

        properties = await zb.zfs.get(datasetName, ["mountpoint"]);
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        volume_context = {
          node_attach_driver: "nfs",
          server: this.options.nfs.shareHost,
          share: properties.mountpoint.value,
        };
        return volume_context;

      case "zfs-generic-iscsi":
        let basename;
        let iscsiName;

        if (this.options.iscsi.nameTemplate) {
          iscsiName = Handlebars.compile(this.options.iscsi.nameTemplate)({
            name: call.request.name,
            parameters: call.request.parameters,
          });
        } else {
          iscsiName = zb.helpers.extractLeafName(datasetName);
        }

        if (this.options.iscsi.namePrefix) {
          iscsiName = this.options.iscsi.namePrefix + iscsiName;
        }

        if (this.options.iscsi.nameSuffix) {
          iscsiName += this.options.iscsi.nameSuffix;
        }

        iscsiName = iscsiName.toLowerCase();

        let extentDiskName = "zvol/" + datasetName;

        /**
         * limit is a FreeBSD limitation
         * https://www.ixsystems.com/documentation/freenas/11.2-U5/storage.html#zfs-zvol-config-opts-tab
         */
        //if (extentDiskName.length > 63) {
        //  throw new GrpcError(
        //    grpc.status.FAILED_PRECONDITION,
        //    `extent disk name cannot exceed 63 characters:  ${extentDiskName}`
        //  );
        //}

        switch (this.options.iscsi.shareStrategy) {
          case "targetCli":
            basename = this.options.iscsi.shareStragetyTargetCli.basename;
            let setAttributesText = "";
            let setAuthText = "";
            if (this.options.iscsi.shareStragetyTargetCli.tpg) {
              if (this.options.iscsi.shareStragetyTargetCli.tpg.attributes) {
                for (const attributeName in this.options.iscsi
                  .shareStragetyTargetCli.tpg.attributes) {
                  const attributeValue = this.options.iscsi
                    .shareStragetyTargetCli.tpg.attributes[attributeName];
                  setAttributesText += "\n";
                  setAttributesText += `set attribute ${attributeName}=${attributeValue}`;
                }
              }

              if (this.options.iscsi.shareStragetyTargetCli.tpg.auth) {
                for (const attributeName in this.options.iscsi
                  .shareStragetyTargetCli.tpg.auth) {
                  const attributeValue = this.options.iscsi
                    .shareStragetyTargetCli.tpg.auth[attributeName];
                  setAttributesText += "\n";
                  setAttributesText += `set auth ${attributeName}=${attributeValue}`;
                }
              }
            }

            response = await this.targetCliCommand(
              `
# create target
cd /iscsi
create ${basename}:${iscsiName}

# setup tpg
cd /iscsi/${basename}:${iscsiName}/tpg1
${setAttributesText}
${setAuthText}

# create extent
cd /backstores/block
create ${iscsiName} /dev/${extentDiskName}

# add extent to target/tpg
cd /iscsi/${basename}:${iscsiName}/tpg1/luns
create /backstores/block/${iscsiName}
`
            );
            break;
          default:
            break;
        }

        // iqn = target
        let iqn = basename + ":" + iscsiName;
        this.ctx.logger.info("iqn: " + iqn);

        volume_context = {
          node_attach_driver: "iscsi",
          portal: this.options.iscsi.targetPortal,
          portals: this.options.iscsi.targetPortals.join(","),
          interface: this.options.iscsi.interface,
          iqn: iqn,
          lun: 0,
        };
        return volume_context;

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driver ${this.options.driver}`
        );
    }
  }

  async deleteShare(call, datasetName) {
    const zb = this.getZetabyte();
    const sshClient = this.getSshClient();

    let response;

    switch (this.options.driver) {
      case "zfs-generic-nfs":
        switch (this.options.nfs.shareStrategy) {
          case "setDatasetProperties":
            break;
          default:
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `invalid configuration: unknown shareStrategy ${this.options.nfs.shareStrategy}`
            );
        }
        break;

      case "zfs-generic-iscsi":
        let basename;
        let iscsiName = zb.helpers.extractLeafName(datasetName);
        if (this.options.iscsi.namePrefix) {
          iscsiName = this.options.iscsi.namePrefix + iscsiName;
        }

        if (this.options.iscsi.nameSuffix) {
          iscsiName += this.options.iscsi.nameSuffix;
        }

        iscsiName = iscsiName.toLowerCase();
        switch (this.options.iscsi.shareStrategy) {
          case "targetCli":
            basename = this.options.iscsi.shareStragetyTargetCli.basename;
            response = await this.targetCliCommand(
              `
cd /iscsi
delete ${basename}:${iscsiName}

cd /backstores/block
delete ${iscsiName}
`
            );
            break;
          default:
            break;
        }
        break;

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driver ${this.options.driver}`
        );
    }

    return {};
  }

  async expandVolume(call, datasetName) {
    switch (this.options.driver) {
      case "zfs-generic-nfs":
        break;

      case "zfs-generic-iscsi":
        switch (this.options.iscsi.shareStrategy) {
          case "targetCli":
            // nothing required, just need to rescan on the node
            break;
          default:
            break;
        }
        break;

      default:
        break;
    }
  }

  async targetCliCommand(data) {
    const sshClient = this.getSshClient();
    data = data.trim();

    let command = "sh";
    let args = ["-c"];
    let taregetCliCommand = [];
    taregetCliCommand.push(`echo "${data}"`.trim());
    taregetCliCommand.push("|");
    taregetCliCommand.push("targetcli");

    if (this.options.iscsi.shareStragetyTargetCli.sudoEnabled) {
      command = "sudo";
      args.unshift("sh");
    }

    args.push("'" + taregetCliCommand.join(" ") + "'");

    return sshClient.exec(sshClient.buildCommand(command, args));
  }
}

module.exports.ControllerZfsGenericDriver = ControllerZfsGenericDriver;
