# Nomad Support

Nomad implements the majority of the CSI specification. Most notably it allows the creation, expansion, deletion of volumes, as well as the creation of snapshots. Most `democratic-csi` features should work out of the box. The official Nomad documentation can be found [here](https://developer.hashicorp.com/nomad/docs/architecture/storage/csi).

These instructions have should work with any share type, but they have only been tested with nfs shares. The detailed discussion can be found at [this issue](https://github.com/democratic-csi/democratic-csi/issues/40).

## Nomad Jobs

`democratic-csi` has to be deployed on Nomad as a set of jobs. The controller job runs as a single instance, while node jobs run on every node (`system` jobs) and manage volume mounting and umounting.

The following job files can be used as an example. Make sure to substitute the config from the [examples](/examples).

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
        image = "democraticcsi/democratic-csi:latest" # use specific versions
        ports = ["grpc"]

        args = [
          "--csi-version=1.5.0",
          "--csi-name=org.democratic-csi.nfs",
          "--driver-config-file=${NOMAD_TASK_DIR}/driver-config-file.yaml",
          "--log-level=debug",
          "--csi-mode=controller",
          "--server-socket=/csi-data/csi.sock",
          "--server-address=0.0.0.0",
          "--server-port=9000",
        ]

      }

      csi_plugin {
        id        = "org.democratic-csi.nfs"
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
        image = "democraticcsi/democratic-csi:latest" # use specific versions

        args = [
          "--csi-version=1.5.0",
          "--csi-name=org.democratic-csi.nfs",
          "--driver-config-file=${NOMAD_TASK_DIR}/driver-config-file.yaml",
          "--log-level=debug",
          "--csi-mode=node",
          "--server-socket=/csi-data/csi.sock",
        ]

        privileged = true
      }

      csi_plugin {
        id        = "org.democratic-csi.nfs"
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

To create a new volume, register an existing one, or update an existing one, we need a [volume specification file](https://developer.hashicorp.com/nomad/docs/other-specifications/volume/csi).

```hcl
id        = "<volume name>"
namespace = "<namespace name>"
name      = "<volume name>"
type      = "csi"
plugin_id = "org.democratic-csi.nfs"

# For 'nomad volume create', specify a snapshot ID or volume to clone. You can
# specify only one of these two fields.
#snapshot_id = "snap-12345"
# clone_id    = "vol-abcdef"

# Optional: for 'nomad volume create', specify a maximum and minimum capacity.
# Registering an existing volume will record but ignore these fields.
# Changing these and running `volume create` again will update the existing volume
capacity_min = "5GiB"
capacity_max = "5GiB"

# Required (at least one): for 'nomad volume create', specify one or more
# capabilities to validate. Registering an existing volume will record but
# ignore these fields.
capability {
  access_mode     = "single-node-writer"
  attachment_mode = "file-system"
}

# Optional: for 'nomad volume create', specify mount options to validate for
# 'attachment_mode = "file-system". Registering an existing volume will record
# but ignore these fields.
#mount_options {
#  fs_type     = "nfs"
#  mount_flags = ["rw"]
#}

```

Afterwards, run the correct Nomad command - either nomad `volume create`(https://developer.hashicorp.com/nomad/commands/volume/create) to create a new volume or update a previously created one; or nomad `volume register`(https://developer.hashicorp.com/nomad/commands/volume/register) to register an already existing one.

