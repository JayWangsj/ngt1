const assert = require("node:assert/strict");

async function runProbe(db, action, code) {
  if (action === "seed") {
    const customer = await db.customer.create({ data: { name: "Update acceptance customer", phone: "390000000000" } });
    const device = await db.device.create({ data: { customerId: customer.id, brand: "NGT", model: "Update acceptance phone" } });
    await db.workOrder.create({ data: { code, deviceId: device.id, fault: "Update acceptance record" } });
    return;
  }
  if (action !== "verify-and-write") throw new Error("Unknown business probe action: " + action);
  const order = await db.workOrder.findUnique({ where: { code }, include: { device: { include: { customer: true } } } });
  assert.equal(order?.fault, "Update acceptance record");
  assert.equal(order?.device?.model, "Update acceptance phone");
  assert.equal(order?.device?.customer?.name, "Update acceptance customer");
  const priorWrite = await db.customer.findFirst({ where: { phone: "390000000001" } });
  const written = priorWrite
    ? await db.customer.update({ where: { id: priorWrite.id }, data: { name: "Post update write" } })
    : await db.customer.create({ data: { name: "Post update write", phone: "390000000001" } });
  assert.equal((await db.customer.findUnique({ where: { id: written.id } }))?.name, "Post update write");
}

module.exports = { runProbe };

if (require.main === module) {
  const [action, envFile, clientPath, code] = process.argv.slice(2);
  process.loadEnvFile(envFile);
  const { PrismaClient } = require(clientPath);
  const db = new PrismaClient();
  runProbe(db, action, code)
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
