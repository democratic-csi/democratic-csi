
# Node info

Node info is common for all storage classes.
Proxy driver must report some values that are compatible with all real drivers.

There are 2 important values:
- topology
- node ID

# Node ID

Node ID is a bit tricky to solve, because of limited field length.

Currently no real driver actually needs `node_id` to work,
so all of this is mostly a proof-of-concept.
A proof that you can create a functional proxy driver even with current CSI spec.

We can replace `node_id` with fixed value, just like we do with `volume_id` field,
before calling the actual real driver method.

Node ID docs are not a part of user documentation because currently this is very theoretical.
Current implementation works fine but doesn't do anything useful for users.

## Node ID: config example

```yaml
# configured in root proxy config
proxy:
  nodeId:
    parts:
      # when value is true, corresponding node info is included into node_id,
      # and can be accessed by proxy driver in controller
      # it allows you to cut info from node_id to make it shorter
      nodeName: true
      hostname: false
      iqn: false
      nqn: false
    # prefix allows you to save shorter values into node_id, so it can fit more than one value
    # on node prefix is replaced with short name, on controller the reverse [can] happen
    nqnPrefix:
    - shortName: '1'
      prefix: 'nqn.2000-01.com.example.nvmeof:'
    - shortName: '2'
      prefix: 'nqn.2014-08.org.nvmexpress:uuid:'
    iqnPrefix:
    - shortName: '1'
      prefix: 'iqn.2000-01.com.example:'
  nodeTopology:
    # 'cluster': all nodes have the same value
    # 'node': each node will get its own topology group
    type: cluster
```

```yaml
# add to each _real_ driver config
proxy:
  perDriver:
    # allowed values: nodeName, hostname, iqn, nqn
    # proxy will use this to decide how to fill node_id for current driver
    nodeIdType: nodeName
```

## Node ID: Reasoning why such complex node_id is required

`node_name + iqn + nqn` can be very long.

Each of these values can theoretically exceed 200 symbols in length.
It's unreasonable to expect users to always use short values.

But it's reasonable to expect that IQNs and NQNs in the cluster will have only a few patterns.
Many clusters likely only use one pattern with only a short variable suffix.
Even if not all nodes follow the same pattern, the amount of patterns is limited.

Saving short suffix allows you to fit all identifiers into node_id without dynamic state.

Values example:

- node name: `node-name.cluster-name.customer-name.suffix`
- iqn: `iqn.2000-01.com.example:qwerty1234`
- nqn: `nqn.2014-08.org.nvmexpress:uuid:68f1d462-633b-4085-a634-899b88e5af74`
- node_id: `n=node-name.cluster-name.customer-name.suffix/i1=qwerty1234/v2=68f1d462-633b-4085-a634-899b88e5af74`
- - Note: even with kinda long node name and default debian IQN and NQN values this still comfortably fits into `node_id` length limit of 256 chars.
- - Maybe we could add prefix and suffix mechanism for node name if very long node name is an issue in real production clusters.
    I'm not too familiar with managed k8s node name practices.

For example, if driver needs iqn, proxy will find field in node id starting with `i`,
search `proxy.nodeId.iqnPrefix` for entry with `shortName = 1`, and then set `node_id` to
`proxy.nodeId.iqnPrefix[name=1].prefix` + `qwerty`

## Node ID: Alternatives to prefixes

Each driver can override `node_id` based on node name.

Each driver can use template for `node_id` based on node name and/or hostname.

Config example:

```yaml
# add to each _real_ driver config
proxy:
  perDriver:
    # local means that this driver uses node ID template instead of using values from NodeGetInfo
    # Individual nodes can use nodeIdMap instead of template.
    # Possibly, even all nodes could use nodeIdMap.
    nodeIdType: local
    nodeIdMap:
    - nodeName: node1
      value: nqn.2000-01.com.example:qwerty
    - nodeName: node2
      value: nqn.2000-01.com.example:node2
    nodeIdTemplate: iqn.2000-01.com.example:{{ hostname }}:{{ nodeName }}-suffix
```

The obvious disadvantage is that it requires a lot more configuration from the user.
Still, if this were to be useful for some reason, this is fully compatible with the current `node_id` format in proxy.

Theoretically, more info can be extracted from node to be used in `nodeIdTemplate`,
provided the info is short enough to fit into `node_id` length limit.

# Topology

There are 3 cases of cluster topology:

- Each node has unique topology domain (`local` drivers)
- All nodes are the same (usually the case for non-local drivers)
- Several availability zones that can contain several nodes
- - https://github.com/democratic-csi/democratic-csi/issues/459

Example configuration:

```yaml
proxy:
  nodeTopology:
    # allowed values:
    # node - each node has its own storage
    # cluster - the whole cluster has unified storage
    # custom - there are several custom zones with internal storage
    type: node
    # topology reported by CSI driver is reflected in k8s as node labels.
    # you may want to set unique prefixes on different drivers to avoid collisions
    prefix: org.democratic-csi.topology
```

There are 2 components to this:
1. Node driver must correctly report its availability zone
2. Controller must set required zone labels in volume

Since proxy driver should work with drivers from potentially different availability zones,
it requires a config to distinguish zones.

## Custom topology: node driver

Driver reports node topology based on the list of rules in the config.

If some rule does not match the input, the rule is ignored.
So, if needed, you can use rules that are only valid on certain nodes.

Config example:

```yaml
proxy:
  nodeTopology:
    type: custom
    prefix: org.democratic-csi.topology
    customRules:
    # resulting topology looks like this:
    # ${ prefix }/${ customRules[*].keySuffix } == ${ customRules[*].resultTemplate }
    - keySuffix: zone
      # possible sources:
      # - nodeName
      # - hostname
      # - env
      # - file
      source: nodeName
      # used only when "source: env"
      envName: DEMOCRATIC_CSI_REGION
      # used only when "source: file"
      # file must be mounted into container filesystem manually
      file: /mnt/topology/region
      # match can:
      # - be exact: "matchRegexp: my-node-1.domain"
      # - use regex: "matchRegexp: .*.domain"
      # - use capture groups: "matchRegexp: .*.(zone-.*).domain"
      # Partial matches are not allowed: driver implicitly appends ^ and $ to regex.
      matchRegexp: my-node-1.domain
      # result template can:
      # - be exact: zone-1
      # - use values from capture groups: zone-${match:1}
      # - - ${match:0} contains the whole input
      # - - ${match:1} contains the first capture group, and so on
      resultTemplate: zone1
    - keySuffix: region
      source: hostname
      matchRegexp: .*-reg(.*)
      resultTemplate: region${match:1}
    - keySuffix: region
      source: nodeName
      # override zone for these 2 nodes
      matchRegexp: n1|n2
      resultTemplate: special-zone
```

Ideas for writing rules:

- Encode zone name in the node name
- Wait for k8s DownwardAPI for node labels
- - Should be alpha in k8s v1.33: https://github.com/kubernetes/kubernetes/issues/40610
- Inject node labels into environment variables via a webhook: https://kyverno.io/policies/other/mutate-pod-binding/mutate-pod-binding/
- Deploy a separate node DaemonSet for each zone, with zone in an environment variable
- Configure each node: place zone info into a file on host

## Custom topology: controller driver

The only thing needed from controller is to set topology requirements when volume is created.

This can be done by adding topology requirements into connection config:

```yaml
# add to each _real_ driver config
proxy:
  perDriver:
    topology:
    # keys must correspond to proxy.nodeTopology.fromRegexp[*].topologyKey
    # values must correspond to values reported by nodes
    - requirements:
        region: region1
        zone: zone1
      # you can add custom node affinity labels
      # they will be added on top of node requirements
      extra: {}
```

Proxy will set these constraints when volume is created, no other configuration is required.

Different connections can have different topology.
