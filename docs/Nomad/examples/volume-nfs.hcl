type = "csi"
id = "csi-volume-nfs"
name = "csi-volume-nfs"
plugin_id = "org.democratic-csi.nfs"
capacity_min = "1GiB"
capacity_max = "1GiB"

capability {
  access_mode     = "multi-node-multi-writer"
  attachment_mode = "file-system"
}
