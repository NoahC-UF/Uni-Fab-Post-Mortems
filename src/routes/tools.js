// "Set up this PC" for the job page's Open Drawings button: instructions and the two small Windows files (set up / remove).

import { getSettings } from '../settings.js';
import { buildSetupBat, drawingsFor } from '../drawings.js';

export default async function toolRoutes(app) {
  const { db } = app.ctx;

  app.get('/tools/folder-button', async (req, reply) => {
    const s = getSettings(db);
    return reply.page('folder_button.njk', { s, example: drawingsFor(s, '092115-1-1') });
  });

  const sendBat = (reply, name, remove) =>
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(buildSetupBat({ remove }));

  app.get('/tools/folder-button/setup.bat', async (req, reply) => sendBat(reply, 'uni-fab-drawings-setup.bat', false));
  app.get('/tools/folder-button/remove.bat', async (req, reply) => sendBat(reply, 'uni-fab-drawings-remove.bat', true));
}
