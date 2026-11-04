const { readFileSync, unlinkSync } = require("node:fs");

const gate = process.env.NGT_RUNTIME_START_GATE;
if (gate) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      if (readFileSync(gate, "utf8") === "ready") break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("The runtime manager did not release the startup gate.");
    Atomics.wait(waitBuffer, 0, 0, 25);
  }
  unlinkSync(gate);
  delete process.env.NGT_RUNTIME_START_GATE;
}
