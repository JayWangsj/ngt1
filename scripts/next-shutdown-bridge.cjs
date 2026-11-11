let shutdownQueued = false;
let signalSent = false;

function deliverShutdown() {
  if (!shutdownQueued || signalSent) return;
  if (process.listenerCount("SIGTERM") === 0) {
    setTimeout(deliverShutdown, 25).unref();
    return;
  }
  signalSent = true;
  process.emit("SIGTERM");
}

process.on("message", (message) => {
  if (message?.type !== "ngt:shutdown") return;
  shutdownQueued = true;
  deliverShutdown();
});
