
# Proxy driver with topology support

Proxy driver can support storage connections
that aren't accessible from every node.
You can specify, that connection C1 is only accessible from zone Z1, for example.

See here for general proxy setup: [proxy-driver.md](./proxy-driver.md)

# Topology support in Helm values

In addition to general proxy values you need to add extra args for `externalProvisioner`:

```yaml
csiDriver:
  name: org.democratic-csi.proxy-topology
controller:
  extraVolumes:
  - name: connections
    secret:
      secretName: connections
  driver:
    extraVolumeMounts:
    - name: connections
      mountPath: /mnt/connections
  externalProvisioner:
    extraArgs:
    - --feature-gates=Topology=true
    # strict-topology and immediate-topology can be altered,
    # see below in storage class description or in this link
    # https://github.com/kubernetes-csi/external-provisioner#topology-support
    - --strict-topology=true
    - --immediate-topology=false
```

# Topology support in storage connection

Add the following proxy-specific part into your connection config:

```yaml
proxy:
  perDriver:
    topology:
    # use short keys, proxy will automatically add a prefix
    - accessibleFrom:
        zone: zone1
```

Config specified above will do the following:
- Volumes created for this connection will get node affinity for label `org.democratic-csi.topology/zone=zone1`
- When you create a PVC, it will generally fail if pod is scheduled outside of `zone1`
- - See [below](#topology-support-in-storage-class) for alternative options

# Topology support in nodes

Proxy driver needs to be able to report supported topology zones on each node.

Add `proxy.nodeTopology` to your proxy config file to configure topology.
You have several options to obtain values:

```yaml
proxy:
  nodeTopology:
    topologyKeyPrefix: org.democratic-csi.topology
    fromRegexp:
    - topologyKey: zone
      # extracting zone from node name
      source: nodeName
      regexp: .*-z(.*)
      template: zone${match:1}
    - topologyKey: zone
      # extracting zone from hostname
      source: hostname
      regexp: .*-z(.*)
      template: zone${match:1}
    - topologyKey: zone
      source: env
      envName: DEMOCRATIC_CSI_ZONE
      # template will just copy source if you omit regexp and value
      # regexp: (.*)
      # template: ${match:1}
    - topologyKey: zone
      source: file
      file: /mnt/topology/complex-topology-file
      regexp: zoneName=(.*)
      template: zone-${match:1}
```

You will need to figure out how to provide zone info into the democratic-csi container.

# Topology support in storage class

Topology of the node is decided during volume creation.
K8s (or another container orchestration tool) sets requirements,
and driver must decide how to satisfy them or decline the request.

In k8s there are 3 main ways to set requirements.
They are described in more details and with alternative options here:
https://github.com/kubernetes-csi/external-provisioner#topology-support

1. No requirements. Topology matching during volume creation is disabled.

- Volume creation will never fail.
- NodeAffinity for volume is based on connection config only.
- Pod affinity requirements are ignored.

Deployment requirements:
- Requires `--immediate-topology=false`.
- `--strict-topology` does not matter
- Requires `volumeBindingMode: Immediate`.

Storage class example:

```yaml
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: s1
provisioner: org.democratic-csi.proxy-topology
volumeBindingMode: Immediate
parameters:
  connection: c1
```

2. Topology matching is based on storage class config.

- Requirements are based ONLY on Storage Class.
- Volume creation will fail if: storage class parameters do not match connection config parameters.
- Pod affinity requirements are ignored.

Deployment requirements:
- Requires `--strict-topology=false`.
- Requires `allowedTopologies` to be present.
- `--immediate-topology` does not matter

Storage class example:

```yaml
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: s1
provisioner: org.democratic-csi.proxy-topology
# volumeBindingMode can be either Immediate or WaitForFirstConsumer
volumeBindingMode: Immediate
parameters:
  connection: c1
allowedTopologies:
- matchLabelExpressions:
  - key: org.democratic-csi.topology/zone
    values:
    - zone1
```

3. Topology matching is based on pod scheduling:

- Requirements are based ONLY on the first consumer pod.
- Volume is allocated in the zone that the first pod is scheduled to
- Volume creation will fail if: pod node does not match connection config.

Deployment requirements:
- Requires `--strict-topology=true`.
- Requires `volumeBindingMode: WaitForFirstConsumer`.
- `--immediate-topology` does not matter

Storage class example:

```yaml
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: s1
provisioner: org.democratic-csi.proxy-topology
volumeBindingMode: WaitForFirstConsumer
parameters:
  connection: c1
```
