// Manually run the local special-fixture harness:  npm run harness
import { startHarnessServer, startFailingGateway, SPECIAL } from './special-fixtures.js';

const { port } = await startHarnessServer({ port: 8790 });
const gw = await startFailingGateway({ port: 8791 });
console.log('Northstar harness (local only):');
console.log(`  Google rate-limit fixture  http://${SPECIAL.harnessHost}:${port}${SPECIAL.googleRateLimit.localPath}`);
console.log(`  YouTube gate fixture       http://${SPECIAL.harnessHost}:${port}${SPECIAL.youtubeGate.localPath}`);
console.log(`  Failing proxy gateway      127.0.0.1:${gw.port}  (point a browser's proxy here to get a 502 / tunnel failure)`);
