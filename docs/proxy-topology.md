
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
# add to each _real_ driver config
proxy:
  perDriver:
    topology:
    # keys must correspond to proxy.nodeTopology.fromRegexp[*].topologyKey
    # values must correspond to values reported by nodes
    - requirements:
        # use short keys, proxy will automatically add a prefix
        region: region1
        zone: zone1
      # you can add custom node affinity labels
      # they will be added on top of node requirements
      # specify full labels here
      extra:
        custom.prefix/custom.name: custom.value
```

Config specified above will do the following:
- If PVC is created with zone requirements, proxy will check them against `proxy.perDriver.topology.requirements` before creating volume
- Volumes created for this connection will get node affinity for labels:
- - `prefix/region: region1`
- - `prefix/zone: zone1`
- - `custom.prefix/custom.name: custom.value`
- Pods consuming this volume will be schedulable only on nodes having all of these labels

# Topology support in nodes

Proxy driver needs to be able to report supported topology zones on each node.

Add `proxy.nodeTopology` to your proxy config file to configure topology.
Check corresponding example section for available options: [proxy.yaml](../examples/proxy.yaml).

Driver reports node topology based on the list of rules in the config.

If some rule does not match the input, the rule is ignored.
So, if needed, you can use rules that are only valid on certain nodes.

Ideas for writing rules:

- Encode zone name in the node name
- Wait for k8s DownwardAPI for node labels
- - Should be alpha in k8s v1.33: https://github.com/kubernetes/kubernetes/issues/40610
- Inject node labels into environment variables via a webhook: https://kyverno.io/policies/other/mutate-pod-binding/mutate-pod-binding/
- Deploy a separate node DaemonSet for each zone, with zone in an environment variable
- Configure each node: place zone info into a file on host

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
