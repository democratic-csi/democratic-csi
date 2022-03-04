class GrpcError {
  constructor(code, message = "") {
    this.name = "GrpcError";
    this.code = code;
    this.message = message;
  }
}

module.exports.GrpcError = GrpcError;

const grpcImplementation = process.env.GRPC_IMPLEMENTATION || "grpc-uds";
console.log(`grpc implementation: ${grpcImplementation}`);
module.exports.grpc = require(grpcImplementation);
