const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(process.cwd(), 'simulation-results');
fs.mkdirSync(OUT, { recursive: true });

function parseCard(card) {
  const small = card.querySelector('small')?.textContent || '';
  const m = small.match(/Lv\s*(\d+)\s*[·|]\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
  return {
    name: card.querySelector('b')?.textContent?.trim() || 'unknown',
    level: m ? Number(m[1]) : null,
    kills: m ? Number(m[2]) : 0,
    deaths: m ? Number(m[3]) : 0,
    assists: m ? Number(m[4]) : 0,
    dead: card.classList.contains('dead'),
    team: card.closest('.spt')?.classList.contains('blue') ? 'blue' : 'red'
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const report = {
    startedAt: new Date().toISOString(),
    matches: [],
    summary: {},
    failures: []
  };

  try {
    for (let matchNo = 1; matchNo <= 5; matchNo++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', e => errors.push({ type: 'pageerror', message: e.message, stack: e.stack }));
      page.on('console', msg => { if (msg.type() === 'error') errors.push({ type: 'console', message: msg.text() }); });
      page.on('requestfailed', req => errors.push({ type: 'requestfailed', url: req.url(), error: req.failure()?.errorText }));

      const match = { matchNo, samples: [], errors, completed: false, outcome: null, wallSeconds: 0 };
      const t0 = Date.now();

      try {
        await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('#mSpec', { timeout: 15000 });
        await page.locator('#mSpec').click();
        await page.waitForFunction(() => {
          const e = document.querySelector('#specPickMode');
          return e && !e.hidden;
        }, null, { timeout: 10000 });
        await page.locator('#specPickAI').click();

        // 밴픽을 빠르게 끝내 실제 10인 전투로 진입
        await page.waitForTimeout(2500);
        if (await page.locator('#adSkip').isVisible().catch(() => false)) {
          await page.locator('#adSkip').click();
        }
        await page.waitForFunction(() => {
          const e = document.querySelector('#spec');
          return e && !e.hidden && document.querySelectorAll('#spec .spk').length === 10;
        }, null, { timeout: 25000 });

        await page.locator('#spec [data-spd="4"]').click();

        const durationMs = 70000;
        let nextSample = 0;
        while (Date.now() - t0 < durationMs) {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          if (elapsed >= nextSample) {
            const snap = await page.evaluate(() => {
              const cards = [...document.querySelectorAll('#spec .spk')];
              const rows = cards.map(card => {
                const small = card.querySelector('small')?.textContent || '';
                const m = small.match(/Lv\\s*(\\d+)\\s*[·|]\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*\\/\\s*(\\d+)/);
                return {
                  name: card.querySelector('b')?.textContent?.trim() || 'unknown',
                  level: m ? Number(m[1]) : null,
                  kills: m ? Number(m[2]) : 0,
                  deaths: m ? Number(m[3]) : 0,
                  assists: m ? Number(m[4]) : 0,
                  dead: card.classList.contains('dead'),
                  team: card.closest('.spt')?.classList.contains('blue') ? 'blue' : 'red'
                };
              });
              return {
                cards: rows,
                overVisible: !!document.querySelector('#over') && !document.querySelector('#over').hidden,
                overText: document.querySelector('#overText')?.textContent || '',
                draftVisible: !!document.querySelector('#aiDraft') && getComputedStyle(document.querySelector('#aiDraft')).display !== 'none',
                specVisible: !!document.querySelector('#spec') && !document.querySelector('#spec').hidden
              };
            });
            match.samples.push({ elapsedWallSeconds: elapsed, ...snap });
            nextSample += 10;
            if (snap.overVisible) {
              match.completed = true;
              match.outcome = snap.overText;
              break;
            }
          }
          await page.waitForTimeout(500);
        }
        match.wallSeconds = Math.round((Date.now() - t0) / 1000);
        match.finalCards = match.samples.at(-1)?.cards || [];
        match.teamTotals = ['blue', 'red'].map(team => {
          const cs = match.finalCards.filter(c => c.team === team);
          return {
            team,
            kills: cs.reduce((n, c) => n + c.kills, 0),
            deaths: cs.reduce((n, c) => n + c.deaths, 0),
            assists: cs.reduce((n, c) => n + c.assists, 0),
            avgLevel: cs.length ? +(cs.reduce((n, c) => n + (c.level || 0), 0) / cs.length).toFixed(2) : null,
            deadCount: cs.filter(c => c.dead).length
          };
        });
      } catch (e) {
        match.failure = e.message;
        report.failures.push({ matchNo, message: e.message });
        await page.screenshot({ path: path.join(OUT, 'match-' + matchNo + '-failure.png'), fullPage: true }).catch(() => {});
      }

      match.errors = errors.slice(0, 100);
      report.matches.push(match);
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({
        matchNo,
        wallSeconds: match.wallSeconds,
        completed: match.completed,
        outcome: match.outcome,
        teamTotals: match.teamTotals,
        errors: match.errors.length,
        failure: match.failure || null
      }));
      await page.close();
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      matchesAttempted: report.matches.length,
      matchesCompleted: report.matches.filter(m => m.completed).length,
      matchesEntered: report.matches.filter(m => m.samples?.length).length,
      runtimeErrors: report.matches.reduce((n, m) => n + (m.errors?.filter(e => e.type === 'pageerror').length || 0), 0),
      consoleErrors: report.matches.reduce((n, m) => n + (m.errors?.filter(e => e.type === 'console').length || 0), 0)
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
