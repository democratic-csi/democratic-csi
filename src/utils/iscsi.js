const cp = require("child_process");

function getIscsiValue(value) {
  if (value == "<empty>") return null;
  return value;
}

class ISCSI {
  constructor(options = {}) {
    const iscsi = this;
    iscsi.options = options;

    options.paths = options.paths || {};
    if (!options.paths.iscsiadm) {
      options.paths.iscsiadm = "iscsiadm";
    }

    if (!options.paths.sudo) {
      options.paths.sudo = "/usr/bin/sudo";
    }

    if (!options.timeout) {
      options.timeout = 10 * 60 * 1000;
    }

    if (!options.executor) {
      options.executor = {
        spawn: cp.spawn
      };
    }

    iscsi.iscsiadm = {
      /**
       * iscsiadm -m iface -o show
       * iface_name transport_name,hwaddress,ipaddress,net_ifacename,initiatorname
       */
      async listInterfaces() {
        let args = [];
        args = args.concat(["-m", "iface", "-o", "show"]);
        const result = await iscsi.exec(options.paths.iscsiadm, args);

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        const entries = result.stdout.trim().split("\n");
        const interfaces = [];
        let fields;
        entries.forEach(entry => {
          fields = entry.split(" ");
          interfaces.push({
            iface_name: fields[0],
            transport_name: fields[1].split(",")[0],
            hwaddress: getIscsiValue(fields[1].split(",")[1]),
            ipaddress: getIscsiValue(fields[1].split(",")[2]),
            net_ifacename: getIscsiValue(fields[1].split(",")[3]),
            initiatorname: getIscsiValue(fields[1].split(",")[4])
          });
        });

        return interfaces;
      },

      /**
       * iscsiadm -m iface -o show -I <iface>
       *
       * @param {*} iface
       */
      async showInterface(iface) {
        let args = [];
        args = args.concat(["-m", "iface", "-o", "show", "-I", iface]);
        let result = await iscsi.exec(options.paths.iscsiadm, args);

        const entries = result.stdout.trim().split("\n");
        const i = {};
        let fields, key, value;
        entries.forEach(entry => {
          if (entry.startsWith("#")) return;
          fields = entry.split("=");
          key = fields[0].trim();
          value = fields[1].trim();
          i[key] = getIscsiValue(value);
        });

        return i;
      },

      /**
       * iscsiadm --mode node -T <target> -p <portal> -o new
       *
       * @param {*} tgtIQN
       * @param {*} portal
       * @param {*} attributes
       */
      async createNodeDBEntry(tgtIQN, portal, attributes = {}) {
        let args = [];
        args = args.concat([
          "-m",
          "node",
          "-T",
          tgtIQN,
          "-p",
          portal,
          "-o",
          "new"
        ]);
        await iscsi.exec(options.paths.iscsiadm, args);
        for (let attribute in attributes) {
          let args = [];
          args = args.concat([
            "-m",
            "node",
            "-T",
            tgtIQN,
            "-p",
            portal,
            "-o",
            "update",
            "--name",
            attribute,
            "--value",
            attributes[attribute]
          ]);
          await iscsi.exec(options.paths.iscsiadm, args);
        }
      },

      /**
       * iscsiadm --mode node -T <target> -p <portal> -o delete
       *
       * @param {*} tgtIQN
       * @param {*} portal
       */
      async deleteNodeDBEntry(tgtIQN, portal) {
        let args = [];
        args = args.concat([
          "-m",
          "node",
          "-T",
          tgtIQN,
          "-p",
          portal,
          "-o",
          "delete"
        ]);
        await iscsi.exec(options.paths.iscsiadm, args);
      },

      /**
       * iscsiadm -m session
       */
      async getSessions() {
        let args = [];
        args = args.concat(["-m", "session"]);
        let result;
        try {
          result = await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          // no active sessions
          if (err.code == 21) {
            result = err;
          } else {
            throw err;
          }
        }

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        // protocol: [id] ip:port,target_portal_group_tag targetname
        const entries = result.stdout.trim().split("\n");
        const sessions = [];
        let fields;
        entries.forEach(entry => {
          fields = entry.split(" ");
          sessions.push({
            protocol: entry.split(":")[0],
            id: fields[1].replace("[", "").replace("]", ""),
            portal: fields[2].split(",")[0],
            target_portal_group_tag: fields[2].split(",")[1],
            iqn: fields[3].split(":")[0],
            target: fields[3].split(":")[1]
          });
        });

        return sessions;
      },

      /**
       * iscsiadm -m session
       */
      async getSessionsDetails() {
        let args = [];
        args = args.concat(["-m", "session", "-P", "3"]);
        let result;
        try {
          result = await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          // no active sessions
          if (err.code == 21) {
            result = err;
          } else {
            throw err;
          }
        }

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        let sessionGroups = [];
        let currentSession = [];

        // protocol: [id] ip:port,target_portal_group_tag targetname
        const entries = result.stdout.trim().split("\n");
        // remove first 2 lines
        entries.shift();
        entries.shift();

        for (let i = 0; i < entries.length; i++) {
          let entry = entries[i];
          if (entry.startsWith("Target:")) {
            if (currentSession.length > 0) {
              sessionGroups.push(currentSession);
            }
            currentSession = [entry];
          } else {
            currentSession.push(entry);
          }
          if (i + 1 == entries.length) {
            sessionGroups.push(currentSession);
          }
        }

        const sessions = [];
        for (let i = 0; i < sessionGroups.length; i++) {
          let sessionLines = sessionGroups[i];
          let session = {};
          let currentSection;
          for (let j = 0; j < sessionLines.length; j++) {
            let line = sessionLines[j].trim();

            let uniqueChars = String.prototype.concat(...new Set(line));
            if (uniqueChars == "*") {
              currentSection = sessionLines[j + 1]
                .trim()
                .toLowerCase()
                .replace(/ /g, "_")
                .replace(/\W/g, "");
              j++;
              j++;
              continue;
            }

            let key = line
              .split(":", 1)[0]
              .trim()
              .replace(/ /g, "_")
              .replace(/\W/g, "");
            let value = line
              .split(":")
              .slice(1)
              .join(":")
              .trim();

            if (currentSection) {
              session[currentSection] = session[currentSection] || {};
              switch (currentSection) {
                case "attached_scsi_devices":
                  key = key.toLowerCase();
                  if (key == "host_number") {
                    session[currentSection]["host"] = {
                      number: value.split("\t")[0],
                      state: value
                        .split("\t")
                        .slice(1)
                        .join("\t")
                        .split(":")
                        .slice(1)
                        .join(":")
                        .trim()
                    };
                    while (
                      sessionLines[j + 1] &&
                      sessionLines[j + 1].trim().startsWith("scsi")
                    ) {
                      session[currentSection]["host"]["devices"] =
                        session[currentSection]["host"]["devices"] || [];
                      let line1p = sessionLines[j + 1].split(" ");
                      let line2 = sessionLines[j + 2];
                      let line2p = "";
                      if (line2) {
                        line2p = line2.split(" ");
                        session[currentSection]["host"]["devices"].push({
                          channel: line1p[2],
                          id: line1p[4],
                          lun: line1p[6],
                          attached_scsi_disk: line2p[3].split("\t")[0],
                          state: line2
                            .trim()
                            .split("\t")
                            .slice(1)
                            .join("\t")
                            .split(":")
                            .slice(1)
                            .join(":")
                            .trim()
                        });
                      }

                      j++;
                      j++;
                    }
                    continue;
                  }
                  break;
                case "negotiated_iscsi_params":
                  key = key.charAt(0).toLowerCase() + key.slice(1);
                  key = key.replace(
                    /[A-Z]/g,
                    letter => `_${letter.toLowerCase()}`
                  );
                  break;
              }
              key = key.toLowerCase();
              session[currentSection][key] = value;
            } else {
              key = key.toLowerCase();
              if (key == "target") {
                value = value.split(" ")[0];
              }
              session[key.trim()] = value.trim();
            }
          }
          sessions.push(session);
        }

        return sessions;
      },

      /**
       * iscsiadm -m discovery -t st -p <portal>
       *
       * @param {*} portal
       */
      async discoverTargets(portal) {
        let args = [];
        args = args.concat(["-m", "discovery"]);
        args = args.concat(["-t", "sendtargets"]);
        args = args.concat(["-p", portal]);

        let result;
        try {
          result = await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          throw err;
        }

        // return empty list if no stdout data
        if (!result.stdout) {
          return [];
        }

        const entries = result.stdout.trim().split("\n");
        const targets = [];
        entries.forEach(entry => {
          targets.push({
            portal: entry.split(",")[0],
            target_portal_group_tag: entry.split(" ")[0].split(",")[1],
            iqn: entry.split(" ")[1].split(":")[0],
            target: entry.split(" ")[1].split(":")[1]
          });
        });

        return targets;
      },

      /**
       * iscsiadm -m node -T <target> -p <portal> -l
       *
       * @param {*} tgtIQN
       * @param {*} portal
       */
      async login(tgtIQN, portal) {
        let args = [];
        args = args.concat(["-m", "node", "-T", tgtIQN, "-p", portal, "-l"]);

        try {
          await iscsi.exec(options.paths.iscsiadm, args);
        } catch (err) {
          // already logged in
          if (err.code == 15) {
            return true;
          }
          throw err;
        }

        return true;
      },

      /**
       *
       *
       * @param {*} tgtIQN
       * @param {*} portals
       */
      async logout(tgtIQN, portals) {
        let args = [];
        args = args.concat(["-m", "node", "-T", tgtIQN]);

        if (!Array.isArray(portals)) {
          portals = [portals];
        }
        portals.forEach(p => {
          iscsi
            .exec(options.paths.iscsiadm, args.concat(["-p", p, "-u"]))
            .then(() => {})
            .catch(err => {
              if (err.code == 21) {
                // no matching sessions
              }
            });
        });

        return true;
      },

      async deleteDBEntry(tgtIQN) {}
    };
  }

  exec(command, args, options) {
    const iscsi = this;
    args = args || [];

    let timeout;
    let stdout = "";
    let stderr = "";

    if (iscsi.options.sudo) {
      args.unshift(command);
      command = iscsi.options.paths.sudo;
    }
    console.log("executing iscsi command: %s %s", command, args.join(" "));
    const child = iscsi.options.executor.spawn(command, args, options);

    let didTimeout = false;
    if (options && options.timeout) {
      timeout = setTimeout(() => {
        didTimeout = true;
        child.kill(options.killSignal || "SIGTERM");
      }, options.timeout);
    }

    return new Promise((resolve, reject) => {
      child.stdout.on("data", function(data) {
        stdout = stdout + data;
      });

      child.stderr.on("data", function(data) {
        stderr = stderr + data;
      });

      child.on("close", function(code) {
        const result = { code, stdout, stderr };
        if (timeout) {
          clearTimeout(timeout);
        }
        if (code) {
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }
}

module.exports.ISCSI = ISCSI;
