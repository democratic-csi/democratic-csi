# Nomad Support

While `democratic-csi` fully implements the CSI spec, Nomad currently supports the CSI in a limited capability. Nomad can utilize CSI volumes, but it can not automatically create, destroy, or manage them in any capacity. Volumes have to be created externally and then registered with Nomad. Once Nomad supports the full spec, all `democratic-csi` features should work out of the box. However, these instructions can be used as a temporary solution.

These instructions have should work with any share type, but they have only been tested with nfs shares. The detailed discussion can be found at [this issue](https://github.com/democratic-csi/democratic-csi/issues/40).

## Nomad Jobs

`democratic-csi` has to be deployed on Nomad as a set of jobs. The controller job runs as a single instance. The node job runs on every node and manages mounting the volume.

The following job files can be used as an example. Make sure to substitute the config from the [examples](/examples). __The example exposes the CSI gRPC interface! Please secure it in a production environment!__

`storage-controller.nomad`
```hcl
job "storage-controller" {
  datacenters = ["dc1"]
  type        = "service"

  group "controller" {
    network {
      mode = "bridge"

      port "grpc" {
        static = 9000
        to     = 9000
      }
    }

    task "controller" {
      driver = "docker"

      config {
        image = "democraticcsi/democratic-csi:latest"
        ports = ["grpc"]

        args = [
          "--csi-version=1.2.0",
          "--csi-name=org.democratic-csi.nfs",
          "--driver-config-file=${NOMAD_TASK_DIR}/driver-config-file.yaml",
          "--log-level=debug",
          "--csi-mode=controller",
          "--server-socket=/csi-data/csi.sock",
          "--server-address=0.0.0.0",
          "--server-port=9000",
        ]

        privileged = true
      }

      csi_plugin {
        id        = "truenas"
        type      = "controller"
        mount_dir = "/csi-data"
      }

      template {
        destination = "${NOMAD_TASK_DIR}/driver-config-file.yaml"

        data = <<EOH
config
EOH
      }

      resources {
        cpu    = 30
        memory = 50
      }
    }
  }
}

```

`storage-node.nomad`
```hcl
job "storage-node" {
  datacenters = ["dc1"]
  type        = "system"

  group "node" {
    task "node" {
      driver = "docker"

      config {
        image = "democraticcsi/democratic-csi:latest"

        args = [
          "--csi-version=1.2.0",
          "--csi-name=org.democratic-csi.nfs",
          "--driver-config-file=${NOMAD_TASK_DIR}/driver-config-file.yaml",
          "--log-level=debug",
          "--csi-mode=node",
          "--server-socket=/csi-data/csi.sock",
        ]

        privileged = true
      }

      csi_plugin {
        id        = "truenas"
        type      = "node"
        mount_dir = "/csi-data"
      }

      template {
        destination = "${NOMAD_TASK_DIR}/driver-config-file.yaml"

        data = <<EOH
config
EOH
      }

      resources {
        cpu    = 30
        memory = 50
      }
    }
  }
}

```

## Creating and registering the volumes

To create the volumes, we are going to use the [csc](https://github.com/rexray/gocsi/tree/master/csc) utility. It can be installed via `go`.

```
GO111MODULE=off go get -u github.com/rexray/gocsi/csc
```

To actually volume, use the following command. `csc` can do a lot more, including listing, expanding and deleting volumes, so please take a look at its docs.

```
csc -e tcp://<host>:<port> controller create-volume --req-bytes <volume size in bytes> <volume name>
```

Output
```
"<volume name>"	<volume size in bytes>	"node_attach_driver"="nfs"	"provisioner_driver"="freenas-nfs"	"server"="<server>"	"share"="<share>"
```

While the volume can be registered using the [Nomad cli](https://www.nomadproject.io/docs/commands/volume/register), it is easier to use Terraform and the [Nomad provider](https://registry.terraform.io/providers/hashicorp/nomad/latest/docs), mapping the output to the following template.

- Access mode can be changed. See [point 2](https://github.com/democratic-csi/democratic-csi/issues/40#issuecomment-751613596).
- Mount flags can be specified. See the [provider docs](https://registry.terraform.io/providers/hashicorp/nomad/latest/docs/resources/volume#mount_flags) and [point 3](https://github.com/democratic-csi/democratic-csi/issues/40#issuecomment-751613596)

```hcl
provider "nomad" {
  address = "<nomad address>"
}

resource "nomad_volume" "<volume name>" {
  type                  = "csi"
  plugin_id             = "truenas"
  volume_id             = "<volume name>"
  name                  = "<volume name>"
  external_id           = "<volume name>"
  access_mode           = "single-node-writer"
  attachment_mode       = "file-system"
  deregister_on_destroy = true

  mount_options = {
    fs_type = "nfs"
  }

  context = {
    node_attach_driver = "nfs"
    provisioner_driver = "freenas-nfs"
    server             = "<server>"
    share              = "<share>"
  }
}
```
