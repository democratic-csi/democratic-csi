const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  datasetHasManagedSnapshots,
} = require("../../src/driver/controller-zfs/index");

const MANAGED_PROPERTY_NAME = "democratic-csi:managed_resource";
const DATASET = "tank/k8s/pvs/pvc-8c49880-7201-497c-9cc2-88ebf967daac";

/**
 * Minimal zetabyte stub covering the two calls datasetHasManagedSnapshots
 * makes: zfs.list (legacy path) and zfs.get (source-filtered path).
 *
 * - listSnapshots: rows as returned in `indexed` by zb.zfs.list
 * - getProperties: object as returned by zb.zfs.get / parsePropertyList,
 *   i.e. only entries whose property source matched the requested sources
 */
function fakeZb({ listSnapshots = [], getProperties = {} } = {}) {
  const calls = { list: [], get: [] };
  return {
    calls,
    zfs: {
      list: async function (datasetName, properties, options) {
        calls.list.push({ datasetName, properties, options });
        return {
          properties,
          data: [],
          indexed: listSnapshots,
        };
      },
      get: async function (datasetName, properties, options) {
        calls.get.push({ datasetName, properties, options });
        return getProperties;
      },
    },
  };
}

describe("datasetHasManagedSnapshots - default (legacy) behavior", () => {
  it("blocks when a snapshot reports the managed property as true", async () => {
    // inherited values are indistinguishable from local ones in `zfs list`
    // output, so by default even foreign (sanoid/zfs-auto-snapshot)
    // snapshots block deletion
    const zb = fakeZb({
      listSnapshots: [
        {
          name: `${DATASET}@autosnap_2026-07-05_00:00:16_daily`,
          [MANAGED_PROPERTY_NAME]: "true",
        },
      ],
    });

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), true);
    assert.strictEqual(zb.calls.list.length, 1);
    assert.strictEqual(zb.calls.get.length, 0);
    assert.deepStrictEqual(zb.calls.list[0].options, { types: ["snapshot"] });
  });

  it("is case-insensitive on the property value", async () => {
    const zb = fakeZb({
      listSnapshots: [
        { name: `${DATASET}@snap`, [MANAGED_PROPERTY_NAME]: "TRUE" },
      ],
    });

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), true);
  });

  it("does not block when no snapshot is managed", async () => {
    const zb = fakeZb({
      listSnapshots: [
        { name: `${DATASET}@snap`, [MANAGED_PROPERTY_NAME]: "-" },
      ],
    });

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), false);
  });

  it("does not block when there are no snapshots", async () => {
    const zb = fakeZb();

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), false);
  });

  it("propagates errors (caller decides how to handle)", async () => {
    const zb = fakeZb();
    zb.zfs.list = async () => {
      throw new Error("cannot open 'tank/...': dataset does not exist");
    };

    await assert.rejects(
      datasetHasManagedSnapshots(zb, DATASET),
      /dataset does not exist/
    );
  });
});

describe("datasetHasManagedSnapshots - ignoreForeignSnapshots", () => {
  const opts = { ignoreForeignSnapshots: true };

  it("requests only locally set / received property sources", async () => {
    const zb = fakeZb();

    await datasetHasManagedSnapshots(zb, DATASET, opts);

    assert.strictEqual(zb.calls.list.length, 0);
    assert.strictEqual(zb.calls.get.length, 1);
    assert.deepStrictEqual(zb.calls.get[0].properties, [
      MANAGED_PROPERTY_NAME,
    ]);
    assert.deepStrictEqual(zb.calls.get[0].options, {
      types: ["snapshot"],
      recurse: true,
      sources: ["local", "received"],
    });
  });

  it("does not block when snapshots only inherit the property", async () => {
    // `zfs get -s local,received` omits inherited-only entries entirely,
    // so a dataset with nothing but sanoid autosnaps yields no entries
    const zb = fakeZb({ getProperties: {} });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      false
    );
  });

  it("blocks when a snapshot has the property set directly", async () => {
    const zb = fakeZb({
      getProperties: {
        [`${DATASET}@snapshot-mysnap`]: {
          [MANAGED_PROPERTY_NAME]: {
            value: "true",
            received: "-",
            source: "local",
          },
        },
      },
    });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      true
    );
  });

  it("ignores locally set property values other than true", async () => {
    const zb = fakeZb({
      getProperties: {
        [`${DATASET}@snap`]: {
          [MANAGED_PROPERTY_NAME]: {
            value: "false",
            received: "-",
            source: "local",
          },
        },
      },
    });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      false
    );
  });

  it("ignores snapshots of other datasets returned by recursion", async () => {
    // recursion is required for `zfs get -t snapshot` to descend to the
    // dataset's snapshots at all; guard against entries from children
    const zb = fakeZb({
      getProperties: {
        [`${DATASET}-other@snapshot-mysnap`]: {
          [MANAGED_PROPERTY_NAME]: {
            value: "true",
            received: "-",
            source: "local",
          },
        },
      },
    });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      false
    );
  });

  it("propagates errors (caller decides how to handle)", async () => {
    const zb = fakeZb();
    zb.zfs.get = async () => {
      throw new Error("cannot open 'tank/...': dataset does not exist");
    };

    await assert.rejects(
      datasetHasManagedSnapshots(zb, DATASET, opts),
      /dataset does not exist/
    );
  });
});
