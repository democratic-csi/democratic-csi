job "democratic-csi-iscsi-node" {
  datacenters = ["dc1"]

  # you can run node plugins as service jobs as well, but this ensures
  # that all nodes in the DC have a copy.
  type = "system"

  group "nodes" {
    task "plugin" {
      driver = "docker"

      env {
        CSI_NODE_ID = "${attr.unique.hostname}"
        
        # if you run into a scenario where your iscsi volumes are zeroed each time they are mounted,
        # you can configure the fs detection system used with the following envvar:
        #FILESYSTEM_TYPE_DETECTION_STRATEGY = "blkid"
      }

      config {
        image = "docker.io/democraticcsi/democratic-csi:latest"

        args = [
          "--csi-version=1.5.0",
          # must match the csi_plugin.id attribute below
          "--csi-name=org.democratic-csi.iscsi",
          "--driver-config-file=${NOMAD_TASK_DIR}/driver-config-file.yaml",
          "--log-level=info",
          "--csi-mode=node",
          "--server-socket=/csi/csi.sock",
        ]

        # node plugins must run as privileged jobs because they
        # mount disks to the host
        privileged = true
        ipc_mode = "host"
        network_mode = "host"

        mount {
          type = "bind"
          target = "/host"
          source = "/"
          readonly=false
        }
        
        # if you run into a scenario where your iscsi volumes are zeroed each time they are mounted,
        # you can try uncommenting the following additional mount block:
        #mount {
        #  type     = "bind"
        #  target   = "/run/udev"
        #  source   = "/run/udev"
        #  readonly = true
        #}
      }

      template {
        destination = "${NOMAD_TASK_DIR}/driver-config-file.yaml"

        data = <<EOH
config
EOH
      }

      csi_plugin {
        # must match --csi-name arg
        id        = "org.democratic-csi.iscsi"
        type      = "node"
        mount_dir = "/csi"
      }

      resources {
        cpu    = 500
        memory = 256
      }
    }
  }
}
