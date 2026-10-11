const path = require('node:path');
const {root, npm} = require('./tooling.cjs');
npm(['run','build'],path.join(root,'backend'));
npm(['run','build'],path.join(root,'extension'));
