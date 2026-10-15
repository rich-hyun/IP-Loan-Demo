import fs from 'node:fs';
const target = new URL('../../js/vendor/', import.meta.url);
fs.mkdirSync(target, { recursive: true });
for (const name of ['ethers.umd.min.js', 'ethers.umd.min.js.map']) {
  const source = new URL(`../node_modules/ethers/dist/${name}`, import.meta.url);
  if (fs.existsSync(source)) fs.copyFileSync(source, new URL(name, target));
}
fs.copyFileSync(new URL('../node_modules/ethers/LICENSE.md', import.meta.url), new URL('ethers-LICENSE.md', target));
console.log('Built local ethers 6.15.0 browser dependency (no CDN).');
