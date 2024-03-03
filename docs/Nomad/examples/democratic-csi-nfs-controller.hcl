job "democratic-csi-nfs-controller" {
  datacenters = ["dc1"]

  group "controller" {
    task "plugin" {
      driver = "docker"

      config {
        image = "docker.io/democraticcsi/democratic-csi:${var.version}"

        entrypoint = [
          "${NOMAD_TASK_DIR}/init.sh"
        ]

        network_mode = "host"
        privileged = true
      }

      env {
        NFS_SERVER = "<nfs server>"
        NFS_SHARE  = "<nfs share>"
      }

      # The nfs share is mounted in the controller so it can create the volumes
      # sub directories inside the nfs share
      template {
        destination = "${NOMAD_TASK_DIR}/init.sh"
        perms = "755"

        data = <<-EOT
          #!/bin/sh

          if [ ! -d /storage ]; then
            mkdir -p /storage
          fi

          mount "{{ env "NFS_SERVER" }}:{{ env "NFS_SHARE" }}" /storage

          exec ./bin/democratic-csi \
            --csi-version=1.5.0 \
            --csi-name=org.democratic-csi.nfs \
            --driver-config-file={{ env "NOMAD_TASK_DIR" }}/driver-config-file.yaml \
            --log-level=info \
            --csi-mode=controller \
            --server-socket=/csi/csi.sock
        EOT
      }

      template {
        destination = "${NOMAD_TASK_DIR}/driver-config-file.yaml"

        data = <<EOH
config
EOH
      }

      csi_plugin {
        # must match --csi-name arg
        id        = "org.democratic-csi.nfs"
        type      = "controller"
        mount_dir = "/csi"
      }

      resources {
        cpu    = 500
        memory = 256
      }
    }
  }
}
