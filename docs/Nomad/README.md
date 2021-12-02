# setup

```
cat <<EOF > /etc/nomad.d/csi.hcl
plugin "docker" {
  config {
    allow_privileged = true
    volumes {
      # required for bind mounting host directories
      enabled = true
    }
  }
}
```