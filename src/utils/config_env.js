function substituteEnvVars(config) {
  return config.replace(/{env:(.*)}/gm, (match, varName) => {
    if (!(varName in process.env)) {
      return match;
    }

    return process.env[varName];
  });
}

module.exports.substituteEnvVars = substituteEnvVars;
