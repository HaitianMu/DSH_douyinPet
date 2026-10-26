const { extract } = require('./asar.js');
const [file, outDir, pattern] = process.argv.slice(2);
const filter = pattern ? (p) => new RegExp(pattern).test(p) : null;
const r = extract(file, outDir, filter);
console.log(JSON.stringify(r));
