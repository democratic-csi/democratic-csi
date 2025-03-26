
# Node info

Node info is common for all storage classes.
Proxy driver must report some values that are compatible with all real drivers.

There are 2 important values:
- topology
- node ID

There are only 2 types of topology in democratic-csi:
topology without constraints and node-local volumes.
It's easy to account for with proxy settings.

Node ID is a bit harder to solve, but this page suggests a solution.
Also, currently no real driver actually needs `node_id` to work,
so all of this is mostly a proof-of-concept.
A proof that you can create a functional proxy driver even with current CSI spec.

We can replace `node_id` with fixed value, just like we do with `volume_id` field,
before calling the actual real driver method.

Node ID docs are not a part of user documentation because currently this is very theoretical.
Current implementation works fine but doesn't do anything useful for users.

# Node info: config example

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

# Reasoning why such complex node_id is required

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

## Alternatives to prefixes

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
