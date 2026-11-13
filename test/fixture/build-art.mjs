// The project's own build of its drawings: here, only a list of them.
import { readdirSync, writeFileSync } from 'node:fs';
writeFileSync('built.json', JSON.stringify(readdirSync('art').filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort()));
console.log('built');
