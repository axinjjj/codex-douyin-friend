import { acquireBridgeRunLock } from "../src/douyin-bridge-state.mjs";

const [projectRoot, chatKey] = process.argv.slice(2);
await acquireBridgeRunLock(projectRoot, chatKey);
process.stdout.write("ready\n", "utf8");
setInterval(() => {}, 60_000);
