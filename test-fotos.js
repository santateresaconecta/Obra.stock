/* =============================================================================
   Foto do material — pelo caminho REAL da interface
   =============================================================================
   Mesma disciplina do test-xml.js e do test-obra.js: nada de montar payload à
   mão. O teste abre "Novo material", entrega um PNG de 2000x1500 ao
   input[type=file] e confere o que chegou ao banco e ao Storage.

   O Storage falso recusa arquivo acima de 2 MB e tipo que não seja imagem,
   igual ao balde de verdade. E a tabela materiais só aceita as colunas reais,
   então um "fotoUrl" que virasse coluna errada apareceria aqui.
============================================================================= */
const puppeteer = require('puppeteer');
const fs = require('fs');
const MOCK = fs.readFileSync('mock/supabase-fake.js', 'utf8');
const B = 'http://127.0.0.1:8080';
const FOTO = 'exemplo-foto.png';
const FOTO_BYTES = fs.readFileSync(FOTO);

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
    /* O balde e ficticio: sem isto a <img> nunca carrega, o onerror troca a
       classe da miniatura e o teste mede o vazio em vez da foto. */
    else if (u.includes('/storage/v1/object/public/materiais/'))
      req.respond({ status: 200, contentType: 'image/png', body: FOTO_BYTES });
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
     A) O modulo carregou e o campo aparece
     ============================================================ */
  console.log('\n=== A) O CAMPO DE FOTO ===');
  ok(await p.evaluate(() => typeof window.Fotos === 'object' && !!window.Fotos),
     'o modulo de fotos foi carregado pela ponte');
  ok(await p.evaluate(() => !!window.ObraStockEmpresaId),
     'a empresa do usuario esta disponivel para montar o caminho');

  await p.evaluate(() => Forms.editarMaterial());
  await new Promise(r => setTimeout(r, 700));
  ok(await p.$('#mtFotoArq') !== null, 'o seletor de imagem existe no formulario');
  ok(await p.$eval('#mtFotoArq', e => e.getAttribute('capture')) === 'environment',
     'no celular abre a camera traseira (capture=environment)');
  ok(await p.$eval('#mtFotoArq', e => e.getAttribute('accept')) === 'image/*',
     'o seletor so oferece imagens');
  ok(await p.$eval('#mtFotoDel', e => e.style.display) === 'none',
     'o botao Remover comeca escondido, pois nao ha foto');

  /* ============================================================
     B) Reducao: 2000x1500 tem que virar 1024 no lado maior
     ============================================================ */
  console.log('\n=== B) REDUCAO DA IMAGEM ===');
  const orig = fs.statSync(FOTO).size;
  const el = await p.$('#mtFotoArq');
  await el.uploadFile(FOTO);
  await new Promise(r => setTimeout(r, 3000));

  const recusas = await p.evaluate(() => window.__recusas);
  ok(recusas.length === 0, 'o envio da foto nao foi recusado', JSON.stringify(recusas));

  const arqs = await p.evaluate(() => Object.entries(window.__mockStorage)
    .map(([k, v]) => ({ caminho: k, tamanho: v.tamanho, tipo: v.tipo })));
  ok(arqs.length === 1, 'exatamente um arquivo foi enviado', JSON.stringify(arqs));

  if (arqs.length === 1) {
    const a = arqs[0];
    ok(a.tipo === 'image/jpeg', 'foi convertida para JPEG', a.tipo);
    ok(a.tamanho < orig, 'ficou menor que o original (' + orig + ' B)', a.tamanho + ' B');
    ok(a.tamanho < 300 * 1024, 'cabe bem no plano gratuito (<300 KB)', a.tamanho + ' B');
    ok(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i.test(a.caminho),
       'o caminho e <empresa>/<chave>.jpg, como a politica do balde exige', a.caminho);
  }

  /* A medicao chama Fotos.reduzir direto: e a funcao que de fato corta a
     imagem, e assim o numero nao depende de a <img> ter carregado. */
  const dim = await p.evaluate(async () => {
    const r = await fetch('/exemplo-foto.png');
    const f = new File([await r.blob()], 'f.png', { type: 'image/png' });
    const blob = await window.Fotos.reduzir(f);
    const bmp = await createImageBitmap(blob);
    return { l: bmp.width, a: bmp.height, tipo: blob.type };
  });
  ok(dim && dim.l === 1024 && dim.a === 768,
     'o lado maior virou 1024 px mantendo a proporcao 4:3', JSON.stringify(dim));
  ok(dim && dim.tipo === 'image/jpeg', 'a saida da reducao e JPEG', dim && dim.tipo);

  const prevSrc = await p.$eval('#mtFotoPrev img', e => e.getAttribute('src')).catch(() => null);
  ok(prevSrc && prevSrc.includes('/storage/v1/object/public/materiais/'),
     'a previa aponta para o arquivo enviado', prevSrc);

  ok(await p.$eval('#mtFotoDel', e => e.style.display) !== 'none',
     'o botao Remover apareceu depois do envio');

  /* ============================================================
     C) Salvar grava o endereco no material
     ============================================================ */
  console.log('\n=== C) GRAVACAO NO MATERIAL ===');
  await p.type('#mtDesc', 'Cimento CP-II 50kg');
  await p.evaluate(() => { document.getElementById('mtCod').value = 'MAT-FOTO-1'; });
  await p.click('#mtSalvar');
  await new Promise(r => setTimeout(r, 2500));

  const mat = await p.evaluate(() =>
    (window.__mockDb.materiais || []).find(m => m.codigo === 'MAT-FOTO-1') || null);
  ok(mat !== null, 'o material foi gravado');
  if (mat) {
    ok(typeof mat.foto_url === 'string' && mat.foto_url.length > 0,
       'o endereco da foto foi para a coluna foto_url', JSON.stringify(mat.foto_url));
    ok(/\/storage\/v1\/object\/public\/materiais\//.test(mat.foto_url || ''),
       'o endereco aponta para o balde publico', mat.foto_url);
    ok(/\?v=\d+/.test(mat.foto_url || ''),
       'tem carimbo de versao, senao trocar a foto mostraria a antiga', mat.foto_url);
  }

  const recusas2 = await p.evaluate(() => window.__recusas);
  ok(recusas2.length === 0, 'o banco aceitou a coluna foto_url', JSON.stringify(recusas2));

  /* ============================================================
     D) A miniatura aparece na listagem
     ============================================================ */
  console.log('\n=== D) MINIATURA NA LISTA ===');
  await p.evaluate(() => App.go('materiais'));
  await new Promise(r => setTimeout(r, 1200));
  const minis = await p.evaluate(() => document.querySelectorAll('img.mat-foto').length);
  ok(minis >= 1, 'a miniatura aparece na listagem de materiais', minis);
  const vazias = await p.evaluate(() => document.querySelectorAll('.mat-foto-vazia').length);
  ok(vazias >= 1, 'materiais sem foto mostram a moldura vazia, nao um buraco', vazias);

  /* ============================================================
     E) Remover a foto
     ============================================================ */
  console.log('\n=== E) REMOCAO ===');
  const idMat = mat && mat.id;
  if (idMat) {
    await p.evaluate(i => Forms.editarMaterial(i), idMat);
    await new Promise(r => setTimeout(r, 800));
    ok(await p.$('#mtFotoPrev img') !== null, 'a foto salva reaparece ao reabrir o material');
    await p.click('#mtFotoDel');
    await p.click('#mtSalvar');
    await new Promise(r => setTimeout(r, 2500));

    const dep = await p.evaluate(i => (window.__mockDb.materiais || []).find(m => m.id === i), idMat);
    ok(dep && (dep.foto_url === null), 'foto_url foi limpa no banco',
       dep && JSON.stringify(dep.foto_url));
    const sobrou = await p.evaluate(() => Object.keys(window.__mockStorage).length);
    ok(sobrou === 0, 'o arquivo foi apagado do Storage, sem lixo acumulado', sobrou);
  } else ok(false, 'nao deu para testar a remocao');

  /* ============================================================
     F) Arquivo que nao e imagem
     ============================================================ */
  console.log('\n=== F) ARQUIVO INVALIDO ===');
  await p.evaluate(() => { window.__recusas = []; });
  await p.evaluate(() => Forms.editarMaterial());
  await new Promise(r => setTimeout(r, 700));
  const el2 = await p.$('#mtFotoArq');
  await el2.uploadFile('exemplo-nfe.xml');
  await new Promise(r => setTimeout(r, 2000));
  const rec3 = await p.evaluate(() => window.__recusas);
  ok(rec3.length === 1 && /foto/i.test(rec3[0]),
     'XML no lugar de foto e recusado com aviso claro', JSON.stringify(rec3));
  ok(await p.evaluate(() => Object.keys(window.__mockStorage).length) === 0,
     'nada foi enviado ao Storage');
  await p.evaluate(() => Modal.close());

  ok(erros.length === 0, 'sem erro de JavaScript', erros.join(' | '));

  console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
  await browser.close();
  restaurar();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); restaurar(); process.exit(1); });
