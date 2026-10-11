const path = require('node:path');
const {root, npm} = require('./tooling.cjs');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
for (const directory of ['backend','extension','desktop']) npm(['ci'], path.join(root,directory));
