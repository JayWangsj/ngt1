import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { runProbe } = require("../../scripts/windows-studio-business-probe.cjs");

test("release database probe uses Prisma unique keys and survives repeated writes", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  assert.match(schema, /model Customer\s*\{[^}]*\bid\s+String\s+@id/s);
  assert.match(schema, /model WorkOrder\s*\{[^}]*\bcode\s+String\s+@unique/s);
  assert.doesNotMatch(schema, /model Customer\s*\{[^}]*\bphone\s+String\s+@unique/s);

  const customers = [];
  const devices = [];
  const orders = [];
  const db = {
    customer: {
      async create({ data }) {
        if (customers.some((item) => item.phone === data.phone)) throw new Error("duplicate phone");
        const record = { id: String(customers.length + 1), ...data };
        customers.push(record);
        return record;
      },
      async findFirst({ where }) { return customers.find((item) => item.phone === where.phone) ?? null; },
      async findUnique({ where }) {
        assert.deepEqual(Object.keys(where), ["id"]);
        return customers.find((item) => item.id === where.id) ?? null;
      },
      async update({ where, data }) {
        assert.deepEqual(Object.keys(where), ["id"]);
        const record = customers.find((item) => item.id === where.id);
        Object.assign(record, data);
        return record;
      },
    },
    device: {
      async create({ data }) {
        const record = { id: String(devices.length + 1), ...data };
        devices.push(record);
        return record;
      },
    },
    workOrder: {
      async create({ data }) { orders.push(data); },
      async findUnique({ where }) {
        assert.deepEqual(Object.keys(where), ["code"]);
        const order = orders.find((item) => item.code === where.code);
        const device = devices.find((item) => item.id === order?.deviceId);
        return order && { ...order, device: { ...device, customer: customers.find((item) => item.id === device.customerId) } };
      },
    },
  };
  await runProbe(db, "seed", "CI-TEST");
  await runProbe(db, "verify-and-write", "CI-TEST");
  await runProbe(db, "verify-and-write", "CI-TEST");
  assert.equal(customers.length, 2);
  assert.equal(customers[1].name, "Post update write");
  await assert.rejects(runProbe(db, "invalid", "CI-TEST"), /Unknown business probe action/);
});
