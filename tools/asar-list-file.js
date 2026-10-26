// Write asar listing to a file (avoids large stdout, which the sandbox blocks).
const { list } = require('./asar.js');
const fs = require('fs');
const [file, outFile] = process.argv.slice(2);
const entries = list(file);
fs.writeFileSync(outFile, entries.map((e) => `${e.size}\t${e.path}`).join('\n') + '\n');
console.log('entries=' + entries.length + ' -> ' + outFile);
