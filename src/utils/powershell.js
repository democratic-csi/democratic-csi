const cp = require("child_process");

class Powershell {
    async exec(command, options = {}) {
        if (!options.hasOwnProperty("timeout")) {
            // TODO: cannot use this as fsck etc are too risky to kill
            //options.timeout = DEFAULT_TIMEOUT;
        }

        //cmd := exec.Command("powershell", "-Mta", "-NoProfile", "-Command", command)

        let stdin;
        if (options.stdin) {
            stdin = options.stdin;
            delete options.stdin;
        }

        // https://github.com/kubernetes-csi/csi-proxy/blob/master/pkg/utils/utils.go
        const _command = "powershell";
        const args = [
            "-Mta",
            "-NoProfile",
            "-Command",
            command
        ];

        let command_log = `${_command} ${args.join(" ")}`.trim();
        if (stdin) {
            command_log = `echo '${stdin}' | ${command_log}`
                .trim()
                .replace(/\n/, "\\n");
        }
        console.log("executing powershell command: %s", command_log);

        return new Promise((resolve, reject) => {
            const child = cp.spawn(_command, args, options);
            let stdout = "";
            let stderr = "";

            child.on("spawn", function () {
                if (stdin) {
                    child.stdin.setEncoding("utf-8");
                    child.stdin.write(stdin);
                    child.stdin.end();
                }
            });

            child.stdout.on("data", function (data) {
                stdout = stdout + data;
            });

            child.stderr.on("data", function (data) {
                stderr = stderr + data;
            });

            child.on("close", function (code) {
                const result = { code, stdout, stderr, timeout: false };

                // timeout scenario
                if (code === null) {
                    result.timeout = true;
                    reject(result);
                }

                if (code) {
                    console.log(
                        "failed to execute powershell command: %s, response: %j",
                        command_log,
                        result
                    );
                    reject(result);
                } else {
                    try {
                        result.parsed = JSON.parse(result.stdout);
                    } catch (err) { };
                    resolve(result);
                }
            });
        });
    }
}



module.exports.Powershell = Powershell;