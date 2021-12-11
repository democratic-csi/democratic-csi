type = "csi"
id = "csi-volume-iscsi"
name = "csi-volume-iscsi"
plugin_id = "org.democratic-csi.iscsi"
capacity_min = "1GiB"
capacity_max = "1GiB"

capability {
  access_mode     = "single-node-writer"
  attachment_mode = "file-system"
}

mount_options {
  # ext4|xfs
  # default is ext4 when left unset
  #fs_type     = "ext4"
  #mount_flags = ["noatime"]
}
