import { getPostMortemByJob, snapshotChanges } from '../postmortems.js';
import { buildJobView } from '../jobView.js';
import { notFound } from '../errors.js';
import { getSettings } from '../settings.js';

const JOB_RE = /^[A-Za-z0-9._-]{1,30}$/;

/**
 * One-page printable summary for the review meeting. Uses the frozen snapshot when a
 * post-mortem exists (so the paper matches what the team agreed on), otherwise live numbers.
 * "Print" -> "Save as PDF" in the browser gives the PDF.
 */
export default async function reportRoutes(app) {
  const { db, now } = app.ctx;

  app.get('/jobs/:jobNum/report', async (req, reply) => {
    const { jobNum } = req.params;
    if (!JOB_RE.test(jobNum)) throw notFound('That job');
    const pm = getPostMortemByJob(db, jobNum);
    const live = buildJobView(db, jobNum, { isAdmin: false });
    if (!live && !pm) throw notFound(`Job ${jobNum}`);

    const snap = pm ? pm.snapshot : live.result;
    const ops = snap.ops.filter((o) => o.counts || o.subcontract);
    const counted = snap.ops.filter((o) => !o.subcontract);
    const chart = {
      labels: counted.map((o) => `${o.oprSeq} ${o.opCode}`),
      est: counted.map((o) => o.est.total),
      act: counted.map((o) => o.act.total),
      counted: counted.map((o) => o.counts),
    };
    const causes = pm
      ? db
          .prepare('SELECT rc.name FROM post_mortem_root_causes x JOIN root_causes rc ON rc.id = x.root_cause_id WHERE x.post_mortem_id = ? ORDER BY rc.sort_order')
          .all(pm.id)
          .map((r) => r.name)
      : [];
    const settings = getSettings(db);
    return reply.page('report.njk', {
      pm,
      snap,
      ops,
      chart,
      causes,
      changes: pm ? snapshotChanges(db, pm).changes : [],
      flaggedMaterials: snap.materials.filter((m) => m.flagged || m.pending),
      thresholds: pm?.snapshot?.meta?.settings ?? { greenMax: settings.greenMax, yellowMax: settings.yellowMax, minHours: settings.minHours, minDollars: settings.minDollars },
      generatedAt: now().toISOString().replace('T', ' ').slice(0, 16),
      source: pm ? 'snapshot' : 'live',
    });
  });
}
