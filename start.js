// start.js — interactive start that ensures models and then opens CLI
require('dotenv').config();
const { ensureModels } = require('./lib/models');

(async function(){
  ensureModels([process.env.EMB_MODEL || 'nomic-embed-text', process.env.GEN_MODEL || 'qwen2.5:1.5b']);
  // hand off to query.js (keeps a single code path)
  require('./query');
})();
