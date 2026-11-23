// Manually run the local proxy-gateway fixtures:  npm run harness
// Point a browser's proxy at one of these ports to reproduce a transport failure at
// chrome-error://chromewebdata/. (Google /sorry/ is protocol-only; the YouTube gate is a lane.)
import { startFailingGateway } from './special-fixtures.js';

const g407 = await startFailingGateway({ status: 407, port: 8791 });
const g502 = await startFailingGateway({ status: 502, port: 8792 });
console.log('Northstar proxy fixtures (loopback only, never forward anything):');
console.log(`  407 Proxy Authentication Required  127.0.0.1:${g407.port}`);
console.log(`  502 Bad Gateway                    127.0.0.1:${g502.port}`);
