import IORedis from "ioredis";
const url = process.argv[2];
(async () => {
  const r = new IORedis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
    tls: { servername: new URL(url).hostname },
  });
  const t = setTimeout(() => { console.log("TIMEOUT: no response in 15s"); process.exit(3); }, 15000);
  try {
    const pong = await r.ping();
    await r.set("__conn_test__", "ok", "EX", 30);
    const v = await r.get("__conn_test__");
    console.log(`PING=${pong} GET=${v}  -> UPSTASH OK`);
    clearTimeout(t);
    await r.quit();
    process.exit(0);
  } catch (e) {
    clearTimeout(t);
    console.log("UPSTASH_ERROR:", (e as Error).message);
    process.exit(1);
  }
})();
