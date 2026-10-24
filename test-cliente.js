/* =============================================================================
   Entrada de cliente novo — pelo caminho REAL da interface
   =============================================================================
   Antes desta tela, cadastrar um cliente era SQL colado à mão no painel do
   Supabase, em dois passos. Esquecer o segundo (o contrato) deixava a empresa
   cadastrada e sem contrato — e isso só aparecia semanas depois, quando a
   geração da mensalidade recusava com "empresa sem contrato".

   O teste abre a tela de Cobrança, clica em "Novo cliente", preenche e salva,
   e confere empresa, contrato e acesso. Depois gera a mensalidade do cliente
   recém-criado, que é a prova de que o cadastro ficou completo.
============================================================================= */
const puppeteer = require('puppeteer');
const fs = require('fs');
const { prepararMock, entrar, DEMO_DEV } = require('./test-ajuda');
const MOCK = fs.readFileSync(__dirname + '/mock/supabase-fake.js', 'utf8');
const B = 'http://127.0.0.1:8080';

let pass = 0, fail = 0;
const ok = (c, l, x) => {
  if (c) { pass++; console.log('  OK   ' + l); }
  else { fail++; console.log('  FALHA ' + l + (x !== undefined ? ' -> ' + x : '')); }
};
const esperar = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1280, height: 950 });
  const erros = [];
  p.on('pageerror', e => erros.push(e.message.slice(0, 140)));

  await prepararMock(p, MOCK, DEMO_DEV);   // a tela de Cobranca e so do dev
  ok(await entrar(p, B), 'entrou no sistema');

  await p.evaluate(() => {
    window.__recusas = [];
    const orig = window.Toast && window.Toast.err;
    if (orig) window.Toast.err = function (t, m) {
      window.__recusas.push(t + ': ' + (m || '')); return orig.apply(this, arguments);
    };
  });

  /* ============================================================
     A) A tela e o botao existem, e sao so do desenvolvedor
     ============================================================ */
  console.log('\n=== A) ACESSO A TELA ===');
  await p.evaluate(() => App.go('cobranca'));
  await esperar(1200);
  ok(await p.$('#cbNovo') !== null, 'botao "Novo cliente" na tela de Cobranca');
  ok(await p.$('#cbContrato') !== null, 'botao "Contrato" na tela de Cobranca');
  ok(await p.evaluate(() => !!(window.ObraStockGestao && window.ObraStockGestao.ehDev())),
     'o usuario do teste e reconhecido como desenvolvedor');

  /* ============================================================
     B) Cadastro completo, com acesso
     ============================================================ */
  console.log('\n=== B) CADASTRO DE CLIENTE NOVO ===');
  const antes = await p.evaluate(() => ({
    emp: window.__mockDb.empresas.length,
    ct: window.__mockDb.contratos.length,
    us: window.__mockDb.perfis.length
  }));

  await p.click('#cbNovo');
  await esperar(700);
  ok(await p.$('#ncNome') !== null, 'o formulario abriu');

  await p.type('#ncNome', 'Construtora Pedra Branca Ltda');
  await p.type('#ncCnpj', '98.765.432/0001-10');
  await p.evaluate(() => { document.getElementById('ncValor').value = '420'; });
  await p.evaluate(() => { document.getElementById('ncDia').value = '15'; });
  await p.evaluate(() => { document.getElementById('ncImpl').value = '3500'; });
  await p.type('#ncUser', 'Marcos Pereira');
  await p.type('#ncEmail', 'marcos@pedrabranca.com.br');
  await p.click('#ncSalvar');
  await esperar(2500);

  const recusas = await p.evaluate(() => window.__recusas);
  ok(recusas.length === 0, 'nenhuma recusa do servidor', JSON.stringify(recusas));

  const depois = await p.evaluate(() => {
    const e = window.__mockDb.empresas.find(x => x.nome === 'Construtora Pedra Branca Ltda');
    const c = e && window.__mockDb.contratos.find(x => x.empresa_id === e.id);
    const u = e && window.__mockDb.perfis.find(x => x.empresa_id === e.id);
    return { emp: e || null, ct: c || null, us: u || null,
             totalEmp: window.__mockDb.empresas.length };
  });
  ok(depois.emp !== null, 'a empresa foi criada');
  ok(depois.emp && depois.emp.cnpj === '98.765.432/0001-10', 'CNPJ gravado', depois.emp && depois.emp.cnpj);
  ok(depois.totalEmp === antes.emp + 1, 'criou exatamente uma empresa', depois.totalEmp);

  ok(depois.ct !== null, 'o contrato foi criado junto — sem ele a cobranca recusaria');
  ok(depois.ct && Number(depois.ct.valor_mensal) === 420, 'mensalidade gravada', depois.ct && depois.ct.valor_mensal);
  ok(depois.ct && depois.ct.dia_vencimento === 15, 'dia do vencimento gravado', depois.ct && depois.ct.dia_vencimento);
  ok(depois.ct && Number(depois.ct.valor_implantacao) === 3500, 'implantacao gravada', depois.ct && depois.ct.valor_implantacao);
  ok(depois.ct && depois.ct.status === 'ativo', 'contrato nasce ativo', depois.ct && depois.ct.status);

  ok(depois.us !== null, 'o acesso do responsavel foi criado');
  ok(depois.us && depois.us.papel === 'admin', 'o responsavel entra como admin', depois.us && depois.us.papel);

  /* O link de acesso aparece logo depois de cadastrar: e o passo seguinte
     do trabalho, e mostrar na hora evita cadastrar e esquecer de entregar. */
  const linkNaCriacao = await p.$eval('#lkTexto', e => e.value).catch(() => null);
  ok(linkNaCriacao !== null, 'o link de primeiro acesso aparece ao cadastrar o cliente');
  ok(linkNaCriacao && /type=recovery/.test(linkNaCriacao),
     'e um link para a pessoa definir a propria senha');
  await p.evaluate(() => Modal.close());
  await esperar(500);

  /* ============================================================
     C) A mensalidade do cliente novo gera na hora
     ============================================================ */
  console.log('\n=== C) GERAR A PRIMEIRA MENSALIDADE ===');
  const idNovo = depois.emp && depois.emp.id;
  await p.evaluate(i => { const s = document.getElementById('cbEmp'); s.value = i;
                          s.dispatchEvent(new Event('change')); }, idNovo);
  await esperar(600);
  await p.click('#cbGerar');
  await esperar(1800);

  const cob = await p.evaluate(i => window.__mockDb.cobrancas.filter(c => c.empresa_id === i), idNovo);
  ok(cob.length === 1, 'a mensalidade foi gerada', cob.length);
  ok(cob[0] && Number(cob[0].valor) === 420, 'usou o valor do contrato, nao o padrao', cob[0] && cob[0].valor);
  ok(cob[0] && /-15$/.test(cob[0].vencimento), 'venceu no dia 15, como contratado', cob[0] && cob[0].vencimento);

  /* gerar de novo nao pode duplicar */
  await p.click('#cbGerar');
  await esperar(1500);
  const cob2 = await p.evaluate(i => window.__mockDb.cobrancas.filter(c => c.empresa_id === i), idNovo);
  ok(cob2.length === 1, 'clicar de novo NAO duplica a cobranca do mes', cob2.length);

  /* ============================================================
     D) Recusas
     ============================================================ */
  console.log('\n=== D) O QUE O SISTEMA RECUSA ===');

  await p.evaluate(() => { window.__recusas = []; });
  await p.click('#cbNovo'); await esperar(600);
  await p.click('#ncSalvar'); await esperar(800);
  let r = await p.evaluate(() => window.__recusas);
  ok(r.length === 1 && /raz[aã]o social/i.test(r[0]), 'sem razao social, recusa', JSON.stringify(r));

  await p.evaluate(() => { window.__recusas = []; });
  await p.type('#ncNome', 'Construtora Repetida');
  await p.type('#ncCnpj', '98765432000110');          // mesmo CNPJ, sem pontuacao
  await p.click('#ncSalvar'); await esperar(2000);
  r = await p.evaluate(() => window.__recusas);
  ok(r.length >= 1 && /CNPJ/i.test(r.join(' ')),
     'CNPJ repetido sem pontuacao e reconhecido como o mesmo', JSON.stringify(r));

  await p.evaluate(() => { window.__recusas = []; });
  await p.evaluate(() => { document.getElementById('ncCnpj').value = '';
                           document.getElementById('ncDia').value = '31'; });
  await p.click('#ncSalvar'); await esperar(2000);
  r = await p.evaluate(() => window.__recusas);
  ok(r.length >= 1 && /vencimento|1 e 28/i.test(r.join(' ')),
     'dia 31 e recusado — nao existe em todo mes', JSON.stringify(r));

  await p.evaluate(() => { window.__recusas = []; });
  await p.evaluate(() => { document.getElementById('ncDia').value = '10';
                           document.getElementById('ncEmail').value = 'alguem@x.com'; });
  await p.click('#ncSalvar'); await esperar(1200);
  r = await p.evaluate(() => window.__recusas);
  ok(r.length >= 1 && /nome do respons/i.test(r.join(' ')),
     'e-mail sem nome do responsavel e recusado', JSON.stringify(r));
  await p.evaluate(() => Modal.close());
  await esperar(400);

  /* ============================================================
     E) Tela de contrato
     ============================================================ */
  console.log('\n=== E) AJUSTE DE CONTRATO ===');
  await p.evaluate(() => { window.__recusas = []; });
  await p.evaluate(() => { const s = document.getElementById('cbEmp'); s.value = '';
                           s.dispatchEvent(new Event('change')); });
  await p.click('#cbContrato'); await esperar(600);
  r = await p.evaluate(() => window.__recusas);
  ok(r.length === 1 && /empresa/i.test(r[0]), 'sem empresa escolhida, pede para escolher', JSON.stringify(r));

  await p.evaluate(i => { const s = document.getElementById('cbEmp'); s.value = i;
                          s.dispatchEvent(new Event('change')); }, idNovo);
  await esperar(500);
  await p.click('#cbContrato'); await esperar(1200);
  ok(await p.$('#ctValor') !== null, 'o contrato abriu');
  ok(await p.$eval('#ctValor', e => Number(e.value)) === 420, 'trouxe o valor atual');

  await p.evaluate(() => { document.getElementById('ctValor').value = '480';
                           document.getElementById('ctStatus').value = 'suspenso'; });
  await p.click('#ctSalvar'); await esperar(1500);
  const ctDepois = await p.evaluate(i => window.__mockDb.contratos.find(c => c.empresa_id === i), idNovo);
  ok(ctDepois && Number(ctDepois.valor_mensal) === 480, 'novo valor gravado', ctDepois && ctDepois.valor_mensal);
  ok(ctDepois && ctDepois.status === 'suspenso', 'situacao gravada', ctDepois && ctDepois.status);

  /* ============================================================
     F2) Link de primeiro acesso
     ============================================================ */
  console.log('\n=== F2) LINK DE PRIMEIRO ACESSO ===');
  await p.evaluate(() => Modal.close());
  await esperar(400);
  await p.evaluate(() => App.go('usuarios'));
  await esperar(1500);

  /* Abre o usuario criado junto com o cliente e pede um link novo. */
  const abriu = await p.evaluate(() => {
    /* a linha nao e clicavel: quem abre e o botao [data-edit] dentro dela */
    const alvo = [...document.querySelectorAll('.item')]
      .find(e => /marcos@pedrabranca/i.test(e.textContent));
    const bt = alvo && alvo.querySelector('[data-edit]');
    if (!bt) return false;
    bt.click(); return true;
  });
  ok(abriu, 'o usuario do cliente aparece na lista');
  await esperar(900);

  ok(await p.$('#fuConvite') !== null, 'botao "Gerar link de acesso" existe');
  const rotulo = await p.$eval('#fuConvite', e => e.textContent.trim());
  ok(!/e-mail|email|reenviar senha/i.test(rotulo),
     'o botao nao promete mais e-mail, que nunca chegava', rotulo);

  await p.click('#fuConvite');
  await esperar(1800);

  const lk = await p.$eval('#lkTexto', e => e.value).catch(() => null);
  ok(lk !== null, 'a janela do link abriu');
  ok(lk && /type=recovery/.test(lk), 'o link e de definicao de senha', lk && lk.slice(0, 60));
  ok(lk && /redirect_to=/.test(lk), 'o link volta para o sistema depois');
  ok(await p.$('#lkCopiar') !== null, 'tem botao de copiar');
  ok(await p.$('#lkCopiarMsg') !== null, 'tem mensagem pronta para WhatsApp');

  const avisoPrazo = await p.evaluate(() =>
    /expirar|vale por tempo limitado/i.test(document.querySelector('.stv, .modal, body').textContent));
  ok(avisoPrazo, 'avisa que o link tem prazo e como gerar outro');

  /* O texto do campo precisa ser selecionavel inteiro: no celular, copiar
     link quebrado em varias linhas e erro classico. */
  const selecionavel = await p.$eval('#lkTexto', e => e.readOnly === true);
  ok(selecionavel, 'o campo e somente leitura, para nao editar sem querer');

  await p.evaluate(() => Modal.close());
  await esperar(400);
  await p.evaluate(() => App.go('cobranca'));
  await esperar(1200);

  /* ============================================================
     F) Gerar a mensalidade de todos de uma vez
     ============================================================ */
  console.log('\n=== F) GERACAO EM LOTE ===');
  /* Cenario: a Pedra Branca ficou suspensa no teste anterior; deixo ativa
     de novo e crio uma terceira empresa encerrada, para provar que o lote
     olha a situacao do contrato e nao cobra quem nao deve. */
  await p.evaluate(i => {
    const ct = window.__mockDb.contratos.find(c => c.empresa_id === i);
    ct.status = 'ativo';
    const enc = { id: 'empEnc', nome: 'Construtora Encerrada', criado_em: new Date().toISOString() };
    window.__mockDb.empresas.push(enc);
    window.__mockDb.contratos.push({ id: 'ctEnc', empresa_id: enc.id, plano: 'Sustentação mensal',
      valor_mensal: 300, dia_vencimento: 10, status: 'encerrado',
      inicio: '2026-01-01', fim: '2026-02-28', valor_implantacao: 0, inclui: [] });
    window.__mockDb.cobrancas.length = 0;      // zera para contar com clareza
  }, idNovo);

  const ativos = await p.evaluate(() =>
    window.__mockDb.contratos.filter(c => c.status === 'ativo').length);

  await p.evaluate(() => { window.__recusas = []; });
  await p.click('#cbGerarTodos');
  await esperar(2500);

  const lote = await p.evaluate(() => window.__mockDb.cobrancas.length);
  ok(lote === ativos, 'gerou uma cobranca por contrato ativo', lote + ' de ' + ativos);

  const encerrada = await p.evaluate(() =>
    window.__mockDb.cobrancas.some(c => c.empresa_id === 'empEnc'));
  ok(!encerrada, 'contrato encerrado NAO foi cobrado');

  const r2 = await p.evaluate(() => window.__recusas);
  ok(r2.length === 0, 'nenhuma recusa na geracao em lote', JSON.stringify(r2));

  /* clicar de novo nao pode duplicar nada */
  await p.click('#cbGerarTodos');
  await esperar(2500);
  const lote2 = await p.evaluate(() => window.__mockDb.cobrancas.length);
  ok(lote2 === lote, 'clicar de novo nao duplica nenhuma cobranca', lote2 + ' apos 2a vez');

  ok(erros.length === 0, 'sem erro de JavaScript', erros.slice(0, 2).join(' | '));

  console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
