const fs = require('fs');
let c = fs.readFileSync('styles.css', 'utf8');
c = c.replace(/body\.virtual-link-color-only/g, 'html.virtual-link-color-only');
fs.writeFileSync('styles.css', c);
console.log('done');
