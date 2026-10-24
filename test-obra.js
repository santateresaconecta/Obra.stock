/* =============================================================================
   Cadastro de obra — pelo caminho REAL da interface
   =============================================================================
   O erro relatado: HTTP 400 ao criar obra. Desta vez nenhuma coluna estava
   errada — o payload da tela usa só colunas que existem. A causa é outra:

     um <input type="date"> em branco devolve "", nunca null, e o Postgres
     recusa "" em coluna date:  invalid input syntax for type date: ""

   Confirmado num Postgres de verdade com o schema.sql aplicado. Vale para
   date, numeric, uuid e enum — por isso a correção é genérica, e não um
   remendo no formulário de obra.

   O teste abre "Nova obra", preenche SÓ o nome (que é o mínimo que a tela
   exige) e salva. Se a camada de dados mandar "" para inicio, o Supabase
   falso recusa com 22007, igual ao servidor.
============================================================================= */
const puppeteer = require('puppeteer');
const fs = require('fs');
const MOCK = fs.readFileSync('mock/supabase-fake.js', 'utf8');
const B = 'http://127.0.0.1:8080';

const CFG_PATH = 'assets/js/config.js';
const CFG_ORIG = fs.readFileSync(CFG_PATH, 'utf8');
fs.writeFileSync(CFG_PATH, require('./test-ajuda').DEMO);
const restaurar = () => { try { fs.writeFileSync(CFG_PATH, CFG_ORIG); } catch (e) {} };
['exit', 'SIGINT', 'SIGTERM'].forEach(ev =>
  process.on(ev, () => { restaurar(); if (ev !== 'exit') process.exit(1); }));

let pass = 0, fail = 0;
const ok = (c, l, x) => {
  if (c) { pass++; console.log('  OK   ' + l); }
  else { fail++; console.log('  FALHA ' + l + (x !== undefined ? ' -> ' + x : '')); }
};

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setCacheEnabled(false);
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.endsWith('/sw.js')) req.respond({ status: 404, contentType: 'text/plain', body: '' });
    else if (u.includes('esm.sh')) req.respond({
      status: 200, contentType: 'application/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: MOCK });
    else req.continue();
  });

  const erros = [];
  p.on('pageerror', e => erros.push(e.message.slice(0, 140)));

  // ---------------------------------------------------------------- login
  await p.goto(B + '/login.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 800));
  await p.type('#email', 'ana@teste.com');
  await p.type('#senha', 'senha123');
  await p.click('#btnEntrar');
  await p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
  ok(p.url().includes('index.html'), 'entrou no sistema', p.url());

  await p.evaluate(() => {
    window.__recusas = [];
    const orig = window.Toast && window.Toast.err;
    if (orig) window.Toast.err = function (t, m) {
      window.__recusas.push(t + ': ' + m); return orig.apply(this, arguments);
    };
  });

  /* ============================================================
     A) O caso que quebrou: obra só com nome, data em branco
     ============================================================ */
  console.log('\n=== A) OBRA SEM DATA DE INICIO (o caso relatado) ===');
  await p.evaluate(() => Forms.editarObra());
  await new Promise(r => setTimeout(r, 700));
  ok(await p.$('#obNome') !== null, 'o formulario de nova obra abriu');

  const vazios = await p.evaluate(() =>
    ['obCod', 'obEnd', 'obResp', 'obIni', 'obObs']
      .filter(id => document.getElementById(id) && document.getElementById(id).value === ''));
  ok(vazios.includes('obIni'), 'a data de inicio comeca em branco, como o usuario deixou');

  await p.type('#obNome', 'Residencial Pedra Azul');
  await p.click('#obSalvar');
  await new Promise(r => setTimeout(r, 2500));

  const recusas = await p.evaluate(() => window.__recusas);
  ok(recusas.length === 0, 'o servidor nao recusou a gravacao', JSON.stringify(recusas));

  const obra = await p.evaluate(() =>
    (window.__mockDb.obras || []).find(o => o.nome === 'Residencial Pedra Azul') || null);
  ok(obra !== null, 'a obra foi gravada');
  if (obra) {
    ok(obra.inicio === null || obra.inicio === undefined,
       'a data em branco virou nulo, nao string vazia', JSON.stringify(obra.inicio));
    ok(obra.status === 'planejada', 'o status veio preenchido', obra.status);
    ok(obra.empresa_id, 'a obra ficou ligada a empresa');
  }

  /* ============================================================
     B) Com data preenchida continua funcionando
     ============================================================ */
  console.log('\n=== B) OBRA COM DATA PREENCHIDA ===');
  await p.evaluate(() => Forms.editarObra());
  await new Promise(r => setTimeout(r, 700));
  await p.type('#obNome', 'Galpao Industrial Norte');
  await p.type('#obCod', 'OB-777');
  await p.evaluate(() => { document.getElementById('obIni').value = '2026-03-15'; });
  await p.select('#obStatus', 'andamento');
  await p.click('#obSalvar');
  await new Promise(r => setTimeout(r, 2500));

  const obra2 = await p.evaluate(() =>
    (window.__mockDb.obras || []).find(o => o.nome === 'Galpao Industrial Norte') || null);
  ok(obra2 !== null, 'a obra com data foi gravada');
  if (obra2) {
    ok(obra2.inicio === '2026-03-15', 'a data foi gravada como digitada', obra2.inicio);
    ok(obra2.status === 'andamento', 'o status escolhido foi gravado', obra2.status);
    ok(obra2.codigo === 'OB-777', 'o codigo foi gravado', obra2.codigo);
  }

  /* ============================================================
     C) Limpar a data de uma obra existente tem que apagar de verdade
     ============================================================ */
  console.log('\n=== C) APAGAR A DATA DE UMA OBRA QUE JA TINHA ===');
  const id2 = obra2 && obra2.id;
  if (id2) {
    await p.evaluate(i => Forms.editarObra(i), id2);
    await new Promise(r => setTimeout(r, 700));
    await p.evaluate(() => { document.getElementById('obIni').value = ''; });
    await p.click('#obSalvar');
    await new Promise(r => setTimeout(r, 2500));
    const dep = await p.evaluate(i => (window.__mockDb.obras || []).find(o => o.id === i), id2);
    ok(dep && (dep.inicio === null), 'a data foi apagada (virou nulo, nao sumiu do update)',
       dep && JSON.stringify(dep.inicio));
  } else ok(false, 'nao deu para testar a limpeza da data');

  const recusasFim = await p.evaluate(() => window.__recusas);
  ok(recusasFim.length === 0, 'nenhuma recusa do servidor em todo o percurso',
     JSON.stringify(recusasFim));
  ok(erros.length === 0, 'sem erro de JavaScript', erros.join(' | '));

  console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
  await browser.close();
  restaurar();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); restaurar(); process.exit(1); });
