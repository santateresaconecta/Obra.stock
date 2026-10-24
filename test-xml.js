/* =============================================================================
   Importação de XML de NF-e — pelo caminho REAL da interface
   =============================================================================
   Por que este arquivo existe separado:

   O teste anterior que escrevi para a NF-e montava o payload à mão, do jeito
   que eu ACHAVA que a tela enviava. Ele passou, e a produção continuou
   devolvendo HTTP 400 — porque eu testei a minha suposição, não o programa.

   Aqui nada é suposto: o teste abre o sistema, faz login, abre "Importar XML",
   entrega um arquivo .xml de verdade ao input[type=file], clica em confirmar e
   só então olha o que chegou ao banco. O Supabase falso agora recusa coluna
   inexistente igual ao PostgREST, então qualquer campo a mais aparece aqui.
============================================================================= */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
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

  // Guarda toda recusa do servidor falso, com a mensagem real do PostgREST.
  await p.evaluate(() => {
    window.__recusas = [];
    const orig = window.Toast && window.Toast.err;
    if (orig) window.Toast.err = function (t, m) { window.__recusas.push(t + ': ' + m); return orig.apply(this, arguments); };
  });

  console.log('\n=== IMPORTACAO PELO CAMINHO REAL ===');
  await p.evaluate(() => Forms.importarXML());
  await new Promise(r => setTimeout(r, 600));

  const input = await p.$('#xmlFile');
  ok(input !== null, 'o seletor de arquivo abriu');
  await input.uploadFile(path.resolve('exemplo-nfe.xml'));
  await new Promise(r => setTimeout(r, 1500));

  const leu = await p.evaluate(() => /XML lido com sucesso/i.test(document.body.textContent));
  ok(leu, 'o XML foi lido e os produtos apareceram');

  // "Importar e dar entrada" — id real do botao no rodape do modal
  const clicou = await p.evaluate(() => {
    const alvo = document.querySelector('#xConfirm');
    if (!alvo) return false;
    alvo.click();
    return true;
  });
  ok(clicou, 'botao "Importar e dar entrada" encontrado');
  await new Promise(r => setTimeout(r, 2500));

  // ------------------------------------------------- o que chegou ao banco
  const r = await p.evaluate(() => ({
    recusas:  window.__recusas,
    notas:    (__mockDb.notas || []).length,
    itens:    (__mockDb.nota_itens || []).length,
    movs:     (__mockDb.movimentacoes || []).length,
    colsNota: Object.keys((__mockDb.notas || [])[0] || {}),
    colsMov:  Object.keys((__mockDb.movimentacoes || [])[0] || {}),
    colsForn: Object.keys((__mockDb.fornecedores || [])[0] || {}),
    colsMat:  Object.keys((__mockDb.materiais || [])[0] || {})
  }));

  ok(r.recusas.length === 0, 'o servidor nao recusou nenhuma gravacao',
     r.recusas.join(' | '));
  ok(r.notas === 1, 'a nota fiscal foi gravada', 'notas=' + r.notas);
  ok(r.itens > 0, 'os produtos da nota foram gravados', 'nota_itens=' + r.itens);
  ok(r.movs > 0, 'as movimentacoes de entrada foram gravadas', 'movs=' + r.movs);
  ok(erros.length === 0, 'sem erro de JavaScript', erros.slice(0, 2).join(' | '));

  console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
  if (fail) {
    console.log('\n--- diagnostico ---');
    console.log('recusas :', JSON.stringify(r.recusas, null, 1));
    console.log('nota    :', r.colsNota.join(','));
    console.log('mov     :', r.colsMov.join(','));
    console.log('forn    :', r.colsForn.join(','));
    console.log('material:', r.colsMat.join(','));
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
