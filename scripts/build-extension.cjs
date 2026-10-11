const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'../extension');
const out = path.join(root,'dist');
fs.mkdirSync(out,{recursive:true});
for (const file of ['background.js','content.js','mcp-bridge.js','mcp-options.js','research-background.js','research-content.js','research-page.js']) fs.copyFileSync(path.join(root,'.extension-build',file),path.join(out,file));
for (const file of ['manifest.json','mcp-options.html','mcp-options.css','page-context.js']) fs.copyFileSync(path.join(root,'src',file),path.join(out,file));
fs.cpSync(path.join(root,'src/assets'),path.join(out,'assets'),{recursive:true});
console.log('Chrome bridge built: extension/dist');
