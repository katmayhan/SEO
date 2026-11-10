// Every morning: refresh the last few days of Search Console data.
const { trigger } = require('../../lib/shared');
exports.handler = async () => {
  await trigger('gsc-sync-background', {});
  return { statusCode: 200, body: 'ok' };
};
