// Every Monday: site scan → AI answer checks → weekly analysis (each step starts the next).
const { trigger } = require('../../lib/shared');
exports.handler = async () => {
  await trigger('site-scan-background', { chain: true });
  return { statusCode: 200, body: 'ok' };
};
