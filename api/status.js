const { wrap, status } = require('../lib/handlers');
module.exports = wrap(status, 'GET');
