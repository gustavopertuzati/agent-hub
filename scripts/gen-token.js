'use strict';
// Génère une clé d'invitation collaborateur :  npm run gen-token
const crypto = require('crypto');
const token = 'ork-' + crypto.randomBytes(24).toString('hex');
console.log(token);
console.log('\nAjoutez-la dans .env -> GATEWAY_TOKENS=<existants>,' + token);
