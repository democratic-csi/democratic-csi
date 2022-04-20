if (typeof String.prototype.replaceAll == "undefined") {
  String.prototype.replaceAll = function (match, replace) {
    return this.replace(new RegExp(match, "g"), () => replace);
  };
}
