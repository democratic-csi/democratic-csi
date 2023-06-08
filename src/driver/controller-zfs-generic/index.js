const _ = require("lodash");
const { ControllerZfsBaseDriver } = require("../controller-zfs");
const { GrpcError, grpc } = require("../../utils/grpc");
const GeneralUtils = require("../../utils/general");
const registry = require("../../utils/registry");
const LocalCliExecClient =
  require("../../utils/zfs_local_exec_client").LocalCliClient;
const SshClient = require("../../utils/zfs_ssh_exec_client").SshClient;
const { Zetabyte, ZfsSshProcessManager } = require("../../utils/zfs");

const Handlebars = require("handlebars");

const ISCSI_ASSETS_NAME_PROPERTY_NAME = "democratic-csi:iscsi_assets_name";
const NVMEOF_ASSETS_NAME_PROPERTY_NAME = "democratic-csi:nvmeof_assets_name";
const __REGISTRY_NS__ = "ControllerZfsGenericDriver";
class ControllerZfsGenericDriver extends ControllerZfsBaseDriver {
  getExecClient() {
    return registry.get(`${__REGISTRY_NS__}:exec_client`, () => {
      if (this.options.sshConnection) {
        return new SshClient({
          logger: this.ctx.logger,
          connection: this.options.sshConnection,
        });
      } else {
        return new LocalCliExecClient({
          logger: this.ctx.logger,
        });
      }
    });
  }

  async getZetabyte() {
    return registry.getAsync(`${__REGISTRY_NS__}:zb`, async () => {
      const execClient = this.getExecClient();
      const options = {};
      if (this.options.sshConnection) {
        options.executor = new ZfsSshProcessManager(execClient);
      } else {
        options.executor = execClient;
      }
      options.idempotent = true;

      if (
        this.options.zfs.hasOwnProperty("cli") &&
        this.options.zfs.cli &&
        this.options.zfs.cli.hasOwnProperty("paths")
      ) {
        options.paths = this.options.zfs.cli.paths;
      }

      options.sudo = _.get(this.options, "zfs.cli.sudoEnabled", false);

      if (typeof this.setZetabyteCustomOptions === "function") {
        await this.setZetabyteCustomOptions(options);
      }

      return new Zetabyte(options);
    });
  }

  /**
   * cannot make this a storage class parameter as storage class/etc context is *not* sent
   * into various calls such as GetControllerCapabilities etc
   */
  getDriverZfsResourceType() {
    switch (this.options.driver) {
      case "zfs-generic-nfs":
      case "zfs-generic-smb":
        return "filesystem";
      case "zfs-generic-iscsi":
      case "zfs-generic-nvmeof":
        return "volume";
      default:
        throw new Error("unknown driver: " + this.ctx.args.driver);
    }
  }

  generateSmbShareName(datasetName) {
    const driver = this;

    driver.ctx.logger.verbose(
      `generating smb share name for dataset: ${datasetName}`
    );

    let name = datasetName || "";
    name = name.replaceAll("/", "_");
    name = name.replaceAll("-", "_");

    driver.ctx.logger.verbose(
      `generated smb share name for dataset (${datasetName}): ${name}`
    );

    return name;
  }

  /**
   * should create any necessary share resources
   * should set the SHARE_VOLUME_CONTEXT_PROPERTY_NAME propery
   *
   * @param {*} datasetName
   */
  async createShare(call, datasetName) {
    const driver = this;
    const zb = await this.getZetabyte();
    const execClient = this.getExecClient();

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
                  [key]:
                    this.options.nfs.shareStrategySetDatasetProperties
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

      case "zfs-generic-smb":
        let share;
        switch (this.options.smb.shareStrategy) {
          case "setDatasetProperties":
            for (let key of ["share", "sharesmb"]) {
              if (
                this.options.smb.shareStrategySetDatasetProperties.properties[
                  key
                ]
              ) {
                await zb.zfs.set(datasetName, {
                  [key]:
                    this.options.smb.shareStrategySetDatasetProperties
                      .properties[key],
                });
              }
            }

            share = driver.generateSmbShareName(datasetName);
            break;
          default:
            break;
        }

        properties = await zb.zfs.get(datasetName, ["mountpoint"]);
        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        volume_context = {
          node_attach_driver: "smb",
          server: this.options.smb.shareHost,
          share,
        };
        return volume_context;

      case "zfs-generic-iscsi": {
        let basename;
        let assetName;

        if (this.options.iscsi.nameTemplate) {
          assetName = Handlebars.compile(this.options.iscsi.nameTemplate)({
            name: call.request.name,
            parameters: call.request.parameters,
          });
        } else {
          assetName = zb.helpers.extractLeafName(datasetName);
        }

        if (this.options.iscsi.namePrefix) {
          assetName = this.options.iscsi.namePrefix + assetName;
        }

        if (this.options.iscsi.nameSuffix) {
          assetName += this.options.iscsi.nameSuffix;
        }

        assetName = assetName.toLowerCase();

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
            basename = this.options.iscsi.shareStrategyTargetCli.basename;
            let setAttributesText = "";
            let setAuthText = "";
            if (this.options.iscsi.shareStrategyTargetCli.tpg) {
              if (this.options.iscsi.shareStrategyTargetCli.tpg.attributes) {
                for (const attributeName in this.options.iscsi
                  .shareStrategyTargetCli.tpg.attributes) {
                  const attributeValue =
                    this.options.iscsi.shareStrategyTargetCli.tpg.attributes[
                      attributeName
                    ];
                  setAttributesText += "\n";
                  setAttributesText += `set attribute ${attributeName}=${attributeValue}`;
                }
              }

              if (this.options.iscsi.shareStrategyTargetCli.tpg.auth) {
                for (const attributeName in this.options.iscsi
                  .shareStrategyTargetCli.tpg.auth) {
                  const attributeValue =
                    this.options.iscsi.shareStrategyTargetCli.tpg.auth[
                      attributeName
                    ];
                  setAttributesText += "\n";
                  setAttributesText += `set auth ${attributeName}=${attributeValue}`;
                }
              }
            }

            await GeneralUtils.retry(
              3,
              2000,
              async () => {
                await this.targetCliCommand(
                  `
# create target
cd /iscsi
create ${basename}:${assetName}

# setup tpg
cd /iscsi/${basename}:${assetName}/tpg1
${setAttributesText}
${setAuthText}

# create extent
cd /backstores/block
create ${assetName} /dev/${extentDiskName}

# add extent to target/tpg
cd /iscsi/${basename}:${assetName}/tpg1/luns
create /backstores/block/${assetName}
`
                );
              },
              {
                retryCondition: (err) => {
                  if (err.stdout && err.stdout.includes("Ran out of input")) {
                    return true;
                  }
                  return false;
                },
              }
            );
            break;
          default:
            break;
        }

        // iqn = target
        let iqn = basename + ":" + assetName;
        this.ctx.logger.info("iqn: " + iqn);

        // store this off to make delete process more bullet proof
        await zb.zfs.set(datasetName, {
          [ISCSI_ASSETS_NAME_PROPERTY_NAME]: assetName,
        });

        volume_context = {
          node_attach_driver: "iscsi",
          portal: this.options.iscsi.targetPortal || "",
          portals: this.options.iscsi.targetPortals
            ? this.options.iscsi.targetPortals.join(",")
            : "",
          interface: this.options.iscsi.interface || "",
          iqn: iqn,
          lun: 0,
        };
        return volume_context;
      }

      case "zfs-generic-nvmeof": {
        let basename;
        let assetName;

        if (this.options.nvmeof.nameTemplate) {
          assetName = Handlebars.compile(this.options.nvmeof.nameTemplate)({
            name: call.request.name,
            parameters: call.request.parameters,
          });
        } else {
          assetName = zb.helpers.extractLeafName(datasetName);
        }

        if (this.options.nvmeof.namePrefix) {
          assetName = this.options.nvmeof.namePrefix + assetName;
        }

        if (this.options.nvmeof.nameSuffix) {
          assetName += this.options.nvmeof.nameSuffix;
        }

        assetName = assetName.toLowerCase();

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

        let namespace = 1;

        switch (this.options.nvmeof.shareStrategy) {
          case "nvmetCli":
            {
              basename = this.options.nvmeof.shareStrategyNvmetCli.basename;
              let savefile = _.get(
                this.options,
                "nvmeof.shareStrategyNvmetCli.configPath",
                ""
              );
              if (savefile) {
                savefile = `savefile=${savefile}`;
              }
              let setSubsystemAttributesText = "";
              if (this.options.nvmeof.shareStrategyNvmetCli.subsystem) {
                if (
                  this.options.nvmeof.shareStrategyNvmetCli.subsystem.attributes
                ) {
                  for (const attributeName in this.options.nvmeof
                    .shareStrategyNvmetCli.subsystem.attributes) {
                    const attributeValue =
                      this.options.nvmeof.shareStrategyNvmetCli.subsystem
                        .attributes[attributeName];
                    setSubsystemAttributesText += "\n";
                    setSubsystemAttributesText += `set attr ${attributeName}=${attributeValue}`;
                  }
                }
              }

              let portCommands = "";
              this.options.nvmeof.shareStrategyNvmetCli.ports.forEach(
                (port) => {
                  portCommands += `
cd /ports/${port}/subsystems
create ${basename}:${assetName}
`;
                }
              );

              await GeneralUtils.retry(
                3,
                2000,
                async () => {
                  await this.nvmetCliCommand(
                    `
# create subsystem
cd /subsystems
create ${basename}:${assetName}
cd ${basename}:${assetName}
${setSubsystemAttributesText}

# create subsystem namespace
cd namespaces
create ${namespace}
cd ${namespace}
set device path=/dev/${extentDiskName}
enable

# associate subsystem/target to port(al)
${portCommands}

saveconfig ${savefile}
`
                  );
                },
                {
                  retryCondition: (err) => {
                    if (err.stdout && err.stdout.includes("Ran out of input")) {
                      return true;
                    }
                    return false;
                  },
                }
              );
            }
            break;

          case "spdkCli":
            {
              basename = this.options.nvmeof.shareStrategySpdkCli.basename;
              let bdevAttributesText = "";
              if (this.options.nvmeof.shareStrategySpdkCli.bdev) {
                if (this.options.nvmeof.shareStrategySpdkCli.bdev.attributes) {
                  for (const attributeName in this.options.nvmeof
                    .shareStrategySpdkCli.bdev.attributes) {
                    const attributeValue =
                      this.options.nvmeof.shareStrategySpdkCli.bdev.attributes[
                        attributeName
                      ];
                    bdevAttributesText += `${attributeName}=${attributeValue}`;
                  }
                }
              }

              let subsystemAttributesText = "";
              if (this.options.nvmeof.shareStrategySpdkCli.subsystem) {
                if (
                  this.options.nvmeof.shareStrategySpdkCli.subsystem.attributes
                ) {
                  for (const attributeName in this.options.nvmeof
                    .shareStrategySpdkCli.subsystem.attributes) {
                    const attributeValue =
                      this.options.nvmeof.shareStrategySpdkCli.subsystem
                        .attributes[attributeName];
                    subsystemAttributesText += `${attributeName}=${attributeValue}`;
                  }
                }
              }

              let listenerCommands = `cd /nvmf/subsystem/${basename}:${assetName}/listen_addresses\n`;
              this.options.nvmeof.shareStrategySpdkCli.listeners.forEach(
                (listener) => {
                  let listenerAttributesText = "";
                  for (const attributeName in listener) {
                    const attributeValue = listener[attributeName];
                    listenerAttributesText += ` ${attributeName}=${attributeValue} `;
                  }
                  listenerCommands += `
create ${listenerAttributesText}
`;
                }
              );

              await GeneralUtils.retry(
                3,
                2000,
                async () => {
                  await this.spdkCliCommand(
                    `
# create bdev
cd /bdevs/${this.options.nvmeof.shareStrategySpdkCli.bdev.type}
create filename=/dev/${extentDiskName} name=${basename}:${assetName} ${bdevAttributesText}

# create subsystem
cd /nvmf/subsystem
create nqn=${basename}:${assetName} ${subsystemAttributesText}
cd ${basename}:${assetName}

# create namespace
cd /nvmf/subsystem/${basename}:${assetName}/namespaces
create bdev_name=${basename}:${assetName} nsid=${namespace}

# add listener
${listenerCommands}

cd /
save_config filename=${this.options.nvmeof.shareStrategySpdkCli.configPath}
`
                  );
                },
                {
                  retryCondition: (err) => {
                    if (err.stdout && err.stdout.includes("Ran out of input")) {
                      return true;
                    }
                    return false;
                  },
                }
              );
            }
            break;

          default:
            break;
        }

        // iqn = target
        let nqn = basename + ":" + assetName;
        this.ctx.logger.info("nqn: " + nqn);

        // store this off to make delete process more bullet proof
        await zb.zfs.set(datasetName, {
          [NVMEOF_ASSETS_NAME_PROPERTY_NAME]: assetName,
        });

        volume_context = {
          node_attach_driver: "nvmeof",
          transport: this.options.nvmeof.transport || "",
          transports: this.options.nvmeof.transports
            ? this.options.nvmeof.transports.join(",")
            : "",
          nqn,
          nsid: namespace,
        };
        return volume_context;
      }

      default:
        throw new GrpcError(
          grpc.status.FAILED_PRECONDITION,
          `invalid configuration: unknown driver ${this.options.driver}`
        );
    }
  }

  async deleteShare(call, datasetName) {
    const zb = await this.getZetabyte();
    const execClient = this.getExecClient();

    let response;
    let properties;

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
                try {
                  await zb.zfs.inherit(datasetName, key);
                } catch (err) {
                  if (err.toString().includes("dataset does not exist")) {
                    // do nothing
                  } else {
                    throw err;
                  }
                }
              }
            }
            await GeneralUtils.sleep(2000); // let things settle
            break;
          default:
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `invalid configuration: unknown shareStrategy ${this.options.nfs.shareStrategy}`
            );
        }
        break;

      case "zfs-generic-smb":
        switch (this.options.smb.shareStrategy) {
          case "setDatasetProperties":
            for (let key of ["share", "sharesmb"]) {
              if (
                this.options.smb.shareStrategySetDatasetProperties.properties[
                  key
                ]
              ) {
                try {
                  await zb.zfs.inherit(datasetName, key);
                } catch (err) {
                  if (err.toString().includes("dataset does not exist")) {
                    // do nothing
                  } else {
                    throw err;
                  }
                }
              }
            }
            await GeneralUtils.sleep(2000); // let things settle
            break;
          default:
            throw new GrpcError(
              grpc.status.FAILED_PRECONDITION,
              `invalid configuration: unknown shareStrategy ${this.options.smb.shareStrategy}`
            );
        }
        break;

      case "zfs-generic-iscsi": {
        let basename;
        let assetName;

        // Delete iscsi assets
        try {
          properties = await zb.zfs.get(datasetName, [
            ISCSI_ASSETS_NAME_PROPERTY_NAME,
          ]);
        } catch (err) {
          if (err.toString().includes("dataset does not exist")) {
            return;
          }
          throw err;
        }

        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        assetName = properties[ISCSI_ASSETS_NAME_PROPERTY_NAME].value;

        if (zb.helpers.isPropertyValueSet(assetName)) {
          //do nothing
        } else {
          assetName = zb.helpers.extractLeafName(datasetName);

          if (this.options.iscsi.namePrefix) {
            assetName = this.options.iscsi.namePrefix + assetName;
          }

          if (this.options.iscsi.nameSuffix) {
            assetName += this.options.iscsi.nameSuffix;
          }
        }

        assetName = assetName.toLowerCase();
        switch (this.options.iscsi.shareStrategy) {
          case "targetCli":
            basename = this.options.iscsi.shareStrategyTargetCli.basename;
            await GeneralUtils.retry(
              3,
              2000,
              async () => {
                await this.targetCliCommand(
                  `
# delete target
cd /iscsi
delete ${basename}:${assetName}

# delete extent
cd /backstores/block
delete ${assetName}
`
                );
              },
              {
                retryCondition: (err) => {
                  if (err.stdout && err.stdout.includes("Ran out of input")) {
                    return true;
                  }
                  return false;
                },
              }
            );

            break;
          default:
            break;
        }
        break;
      }

      case "zfs-generic-nvmeof": {
        let basename;
        let assetName;

        // Delete nvmeof assets
        try {
          properties = await zb.zfs.get(datasetName, [
            NVMEOF_ASSETS_NAME_PROPERTY_NAME,
          ]);
        } catch (err) {
          if (err.toString().includes("dataset does not exist")) {
            return;
          }
          throw err;
        }

        properties = properties[datasetName];
        this.ctx.logger.debug("zfs props data: %j", properties);

        assetName = properties[NVMEOF_ASSETS_NAME_PROPERTY_NAME].value;

        if (zb.helpers.isPropertyValueSet(assetName)) {
          //do nothing
        } else {
          assetName = zb.helpers.extractLeafName(datasetName);

          if (this.options.nvmeof.namePrefix) {
            assetName = this.options.nvmeof.namePrefix + assetName;
          }

          if (this.options.nvmeof.nameSuffix) {
            assetName += this.options.nvmeof.nameSuffix;
          }
        }

        assetName = assetName.toLowerCase();
        switch (this.options.nvmeof.shareStrategy) {
          case "nvmetCli":
            {
              basename = this.options.nvmeof.shareStrategyNvmetCli.basename;
              let savefile = _.get(
                this.options,
                "nvmeof.shareStrategyNvmetCli.configPath",
                ""
              );
              if (savefile) {
                savefile = `savefile=${savefile}`;
              }
              let portCommands = "";
              this.options.nvmeof.shareStrategyNvmetCli.ports.forEach(
                (port) => {
                  portCommands += `
cd /ports/${port}/subsystems
delete ${basename}:${assetName}
`;
                }
              );
              await GeneralUtils.retry(
                3,
                2000,
                async () => {
                  await this.nvmetCliCommand(
                    `
# delete subsystem from port
${portCommands}

# delete subsystem
cd /subsystems
delete ${basename}:${assetName}

saveconfig ${savefile}
`
                  );
                },
                {
                  retryCondition: (err) => {
                    if (err.stdout && err.stdout.includes("Ran out of input")) {
                      return true;
                    }
                    return false;
                  },
                }
              );
            }
            break;
          case "spdkCli":
            {
              basename = this.options.nvmeof.shareStrategySpdkCli.basename;
              await GeneralUtils.retry(
                3,
                2000,
                async () => {
                  await this.spdkCliCommand(
                    `
# delete subsystem
cd /nvmf/subsystem/
delete subsystem_nqn=${basename}:${assetName}

# delete bdev
cd /bdevs/${this.options.nvmeof.shareStrategySpdkCli.bdev.type}
delete name=${basename}:${assetName}

cd /
save_config filename=${this.options.nvmeof.shareStrategySpdkCli.configPath}
`
                  );
                },
                {
                  retryCondition: (err) => {
                    if (err.stdout && err.stdout.includes("Ran out of input")) {
                      return true;
                    }
                    return false;
                  },
                }
              );
            }
            break;

          default:
            break;
        }
        break;
      }

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
    const execClient = this.getExecClient();
    const driver = this;

    data = data.trim();

    let command = "sh";
    let args = ["-c"];

    let cliArgs = ["targetcli"];
    if (
      _.get(this.options, "iscsi.shareStrategyTargetCli.sudoEnabled", false)
    ) {
      cliArgs.unshift("sudo");
    }

    let cliCommand = [];
    cliCommand.push(`echo "${data}"`.trim());
    cliCommand.push("|");
    cliCommand.push(cliArgs.join(" "));
    args.push("'" + cliCommand.join(" ") + "'");

    let logCommandTmp = command + " " + args.join(" ");
    let logCommand = "";

    logCommandTmp.split("\n").forEach((line) => {
      if (line.startsWith("set auth password=")) {
        logCommand += "set auth password=<redacted>";
      } else if (line.startsWith("set auth mutual_password=")) {
        logCommand += "set auth mutual_password=<redacted>";
      } else {
        logCommand += line;
      }

      logCommand += "\n";
    });

    driver.ctx.logger.verbose("TargetCLI command: " + logCommand);

    // https://github.com/democratic-csi/democratic-csi/issues/127
    // https://bugs.launchpad.net/ubuntu/+source/python-configshell-fb/+bug/1776761
    // can apply the linked patch with some modifications to overcome the
    // KeyErrors or we can simply start a fake tty which does not seem to have
    // a detrimental effect, only affects Ubuntu 18.04 and older
    let options = {
      pty: true,
    };
    let response = await execClient.exec(
      execClient.buildCommand(command, args),
      options
    );
    driver.ctx.logger.verbose(
      "TargetCLI response: " + JSON.stringify(response)
    );
    if (response.code != 0) {
      throw response;
    }
    return response;
  }

  async nvmetCliCommand(data) {
    const execClient = this.getExecClient();
    const driver = this;

    if (
      _.get(
        this.options,
        "nvmeof.shareStrategyNvmetCli.configIsImportedFilePath"
      )
    ) {
      try {
        let response = await execClient.exec(
          execClient.buildCommand("test", [
            "-f",
            _.get(
              this.options,
              "nvmeof.shareStrategyNvmetCli.configIsImportedFilePath"
            ),
          ])
        );
      } catch (err) {
        throw new Error("nvmet has not been fully configured");
      }
    }

    data = data.trim();

    let command = "sh";
    let args = ["-c"];

    let cliArgs = [
      _.get(
        this.options,
        "nvmeof.shareStrategyNvmetCli.nvmetcliPath",
        "nvmetcli"
      ),
    ];
    if (
      _.get(this.options, "nvmeof.shareStrategyNvmetCli.sudoEnabled", false)
    ) {
      cliArgs.unshift("sudo");
    }

    let cliCommand = [];
    cliCommand.push(`echo "${data}"`.trim());
    cliCommand.push("|");
    cliCommand.push(cliArgs.join(" "));
    args.push("'" + cliCommand.join(" ") + "'");

    let logCommandTmp = command + " " + args.join(" ");
    let logCommand = "";

    logCommandTmp.split("\n").forEach((line) => {
      if (line.startsWith("set auth password=")) {
        logCommand += "set auth password=<redacted>";
      } else if (line.startsWith("set auth mutual_password=")) {
        logCommand += "set auth mutual_password=<redacted>";
      } else {
        logCommand += line;
      }

      logCommand += "\n";
    });

    driver.ctx.logger.verbose("nvmetCLI command: " + logCommand);
    //process.exit(0);

    // https://github.com/democratic-csi/democratic-csi/issues/127
    // https://bugs.launchpad.net/ubuntu/+source/python-configshell-fb/+bug/1776761
    // can apply the linked patch with some modifications to overcome the
    // KeyErrors or we can simply start a fake tty which does not seem to have
    // a detrimental effect, only affects Ubuntu 18.04 and older
    let options = {
      pty: true,
    };
    let response = await execClient.exec(
      execClient.buildCommand(command, args),
      options
    );
    driver.ctx.logger.verbose("nvmetCLI response: " + JSON.stringify(response));
    if (response.code != 0) {
      throw response;
    }
    return response;
  }

  async spdkCliCommand(data) {
    const execClient = this.getExecClient();
    const driver = this;

    data = data.trim();

    let command = "sh";
    let args = ["-c"];

    let cliArgs = [
      _.get(this.options, "nvmeof.shareStrategySpdkCli.spdkcliPath", "spdkcli"),
    ];
    if (_.get(this.options, "nvmeof.shareStrategySpdkCli.sudoEnabled", false)) {
      cliArgs.unshift("sudo");
    }

    let cliCommand = [];
    cliCommand.push(`echo "${data}"`.trim());
    cliCommand.push("|");
    cliCommand.push(cliArgs.join(" "));
    args.push("'" + cliCommand.join(" ") + "'");

    let logCommandTmp = command + " " + args.join(" ");
    let logCommand = "";

    logCommandTmp.split("\n").forEach((line) => {
      if (line.startsWith("set auth password=")) {
        logCommand += "set auth password=<redacted>";
      } else if (line.startsWith("set auth mutual_password=")) {
        logCommand += "set auth mutual_password=<redacted>";
      } else {
        logCommand += line;
      }

      logCommand += "\n";
    });

    driver.ctx.logger.verbose("spdkCLI command: " + logCommand);
    //process.exit(0);

    // https://github.com/democratic-csi/democratic-csi/issues/127
    // https://bugs.launchpad.net/ubuntu/+source/python-configshell-fb/+bug/1776761
    // can apply the linked patch with some modifications to overcome the
    // KeyErrors or we can simply start a fake tty which does not seem to have
    // a detrimental effect, only affects Ubuntu 18.04 and older
    let options = {
      pty: true,
    };
    let response = await execClient.exec(
      execClient.buildCommand(command, args),
      options
    );
    driver.ctx.logger.verbose("spdkCLI response: " + JSON.stringify(response));
    if (response.code != 0) {
      throw response;
    }
    return response;
  }
}

module.exports.ControllerZfsGenericDriver = ControllerZfsGenericDriver;
