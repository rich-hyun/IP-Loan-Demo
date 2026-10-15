import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function compile() {
  const sources = Object.fromEntries(fs.readdirSync(path.join(root, 'contracts')).filter(n => n.endsWith('.sol'))
    .map(n => [`contracts/${n}`, { content: fs.readFileSync(path.join(root, 'contracts', n), 'utf8') }]));
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  } }), { import: name => {
    try { return { contents: fs.readFileSync(path.join(root, 'node_modules', name), 'utf8') }; }
    catch { return { error: `Import missing: ${name}` }; }
  } }));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return Object.fromEntries(Object.entries(output.contracts).filter(([n]) => n.startsWith('contracts/'))
    .flatMap(([source, contracts]) => Object.entries(contracts).map(([name, c]) => [name, {
      contractName: name, sourceName: source, compiler: { version: solc.version(), evmVersion: 'paris', viaIR: true, optimizerRuns: 200 },
      abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`
    }])));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  for (const [name, artifact] of Object.entries(compile())) fs.writeFileSync(path.join(root, 'artifacts', `${name}.json`), JSON.stringify(artifact, null, 2));
  console.log('Local ABI/bytecode generated; no deployment or transactions.');
}
