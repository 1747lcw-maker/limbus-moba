const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(process.cwd(), 'simulation-results');
fs.mkdirSync(OUT, { recursive: true });

function parseCard(card) {
  const small = card.querySelector('small')?.textContent || '';
  const chunks = small.split('·');
  const nums = (chunks[1] || '').trim().split('/').map(x => Number(x.trim()));
  const level = Number((chunks[0] || '').replace('Lv', '').trim()) || null;
  return {
    name: card.querySelector('b')?.textContent?.trim() || 'unknown',
    level: level,
    kills: nums[0] || 0,
    deaths: nums[1] || 0,
    assists: nums[2] || 0,
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
    for (let matchNo = 1; matchNo <= 3; matchNo++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', e => errors.push({ type: 'pageerror', message: e.message, stack: e.stack }));
      page.on('console', msg => { if (msg.type() === 'error') errors.push({ type: 'console', message: msg.text() }); });
      page.on('requestfailed', req => errors.push({ type: 'requestfailed', url: req.url(), error: req.failure()?.errorText }));

      const match = { matchNo, samples: [], errors, completed: false, outcome: null, wallSeconds: 0 };
      const t0 = Date.now();

      try {
        await page.route('http://127.0.0.1:4173/', async route => {
          const response = await route.fetch();
          let html = await response.text();
          const marker = '})();\n</script>';
          const hook = `window.__simState = () => ({
            time,
            gameOver,
            heroes: heroes.map(c => ({key:c.key,name:c.name,team:c.team,role:c.role,level:c.level,k:c.k,d:c.d,a:c.a,hp:Math.round(c.hp),maxHp:Math.round(c.maxHp),alive:c.alive,mode:c.mode,gold:Math.round(c.gold)})),
            structures: units.filter(u => u.kind === 'turret' || u.kind === 'nexus').map(u => ({kind:u.kind,team:u.team,alive:u.alive,hp:Math.round(u.hp),maxHp:Math.round(u.maxHp)}))
          });\n`;
          if (!html.includes(marker)) throw new Error('Could not inject simulation state hook');
          html = html.replace(marker, hook + marker);
          await route.fulfill({ response, body: html });
        });
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

        await page.locator('#spec [data-spd="4"]').evaluate(el => { el.dataset.spd = '12'; });
        await page.locator('#spec [data-spd="12"]').click();

        const durationMs = 150000;
        let nextSample = 0;
        while (Date.now() - t0 < durationMs) {
          const elapsed = Math.round((Date.now() - t0) / 1000);
          if (elapsed >= nextSample) {
            const snap = await page.evaluate(() => {
              const cards = [...document.querySelectorAll('#spec .spk')];
              const rows = cards.map(card => {
                const small = card.querySelector('small')?.textContent || '';
                const chunks = small.split('·');
  const nums = (chunks[1] || '').trim().split('/').map(x => Number(x.trim()));
  const level = Number((chunks[0] || '').replace('Lv', '').trim()) || null;
                return {
                  name: card.querySelector('b')?.textContent?.trim() || 'unknown',
                  level: level,
                  kills: nums[0] || 0,
                  deaths: nums[1] || 0,
                  assists: nums[2] || 0,
                  dead: card.classList.contains('dead'),
                  team: card.closest('.spt')?.classList.contains('blue') ? 'blue' : 'red'
                };
              });
              return {
                cards: rows,
                simState: window.__simState ? window.__simState() : null,
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
        match.finalState = match.samples.at(-1)?.simState || null;
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
    const championTotals = {};
    for (const match of report.matches) {
      for (const card of (match.finalCards || [])) {
        const row = championTotals[card.name] || (championTotals[card.name] = { appearances: 0, kills: 0, deaths: 0, assists: 0, levelTotal: 0, levelSamples: 0 });
        row.appearances++;
        row.kills += card.kills || 0;
        row.deaths += card.deaths || 0;
        row.assists += card.assists || 0;
        if (card.level != null) { row.levelTotal += card.level; row.levelSamples++; }
      }
    }
    for (const row of Object.values(championTotals)) {
      row.kda = row.deaths ? +((row.kills + row.assists) / row.deaths).toFixed(2) : null;
      row.avgLevel = row.levelSamples ? +(row.levelTotal / row.levelSamples).toFixed(2) : null;
    }
    report.championTotals = championTotals;
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
