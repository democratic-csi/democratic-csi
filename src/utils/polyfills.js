if (typeof String.prototype.replaceAll == "undefined") {
  String.prototype.replaceAll = function (match, replace) {
    return this.replace(new RegExp(match, "g"), () => replace);
  };
}

Array.prototype.random = function () {
  return this[Math.floor(Math.random() * this.length)];
};
