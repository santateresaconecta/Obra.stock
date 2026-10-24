/* Etapa 4 — valida a camada de dados contra um Supabase falso em memória. */
const puppeteer = require('puppeteer');
const fs = require('fs');
require('fs').mkdirSync('pv', { recursive: true });   // pasta das capturas: nao vem no repositorio
const MOCK = fs.readFileSync('mock/supabase-fake.js', 'utf8');
const B = 'http://127.0.0.1:8080';
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log('  OK   ' + l); }
  else { fail++; console.log('  FALHA ' + l + (x !== undefined ? ' -> ' + x : '')); } };

/* Em vez de interceptar config.js (o navegador reaproveitava o módulo entre
   as duas páginas), escrevemos credenciais de teste no arquivo real e
   restauramos no fim. Mais perto do que acontece em produção. */
const CFG_PATH = 'assets/js/config.js';
const CFG_ORIG = fs.readFileSync(CFG_PATH, 'utf8');
/* Monta as credenciais de teste a partir do arquivo real, sem supor que ele
   venha preenchido ou com placeholder — essa suposicao ja quebrou 5 testes. */
fs.writeFileSync(CFG_PATH, require('./test-ajuda').DEMO);
const restaurar = () => { try { fs.writeFileSync(CFG_PATH, CFG_ORIG); } catch(e){} };
process.on('exit', restaurar);
process.on('SIGINT', () => { restaurar(); process.exit(1); });

async function novaPagina(browser){
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setCacheEnabled(false);
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = req.url();
    if (u.endsWith('/sw.js'))                            // SW serviria do cache
      req.respond({ status:404, contentType:'text/plain', body:'' });
    else if (u.includes('esm.sh'))                       // SDK real -> o falso
      req.respond({ status:200, contentType:'application/javascript', headers:{'Access-Control-Allow-Origin':'*'}, body: MOCK });
    else req.continue();
  });
  p.on('pageerror', e => console.log('    [pageerror] ' + e.message.slice(0, 110)));
  return p;
}

(async () => {
  const browser = await puppeteer.launch({ args:['--no-sandbox','--disable-setuid-sandbox'] });

  console.log('=== A. LOGIN REAL ===');
  const p = await novaPagina(browser);
  await p.goto(B + '/login.html', { waitUntil:'networkidle2' });
  await new Promise(r => setTimeout(r, 900));
  ok(!(await p.$eval('#btnEntrar', e => e.disabled)), 'formulario habilitado com credenciais');

  await p.type('#email', 'ana@teste.com');
  await p.type('#senha', 'errada');
  await p.click('#btnEntrar');
  await new Promise(r => setTimeout(r, 700));
  let m = await p.$eval('#msgLogin', e => e.textContent.trim());
  ok(/incorret|inválid/i.test(m), 'senha errada: mensagem traduzida', m);
  ok(!/email|e-mail não/i.test(m) || !/não cadastrado/i.test(m),
     'nao revela se o e-mail existe', m);

  await p.$eval('#senha', e => e.value = '');
  await p.type('#senha', 'senha123');
  await p.click('#btnEntrar');
  await p.waitForNavigation({ waitUntil:'networkidle2', timeout:15000 }).catch(()=>{});
  await new Promise(r => setTimeout(r, 2500));
  ok(p.url().includes('index.html'), 'login correto entra no sistema', p.url());

  console.log('\n=== B. DADOS VINDOS DO BANCO ===');
  const vis = await p.evaluate(() => getComputedStyle(document.documentElement).visibility);
  ok(vis === 'visible', 'tela liberada apos carregar dados', vis);
  const nome = await p.$eval('#sbUser', e => e.textContent.trim());
  ok(nome === 'Ana Souza', 'nome do perfil real na barra lateral', nome);
  const cargo = await p.$eval('#sbVersion', e => e.textContent.trim());
  ok(/Administrador/i.test(cargo), 'papel exibido', cargo);
  ok(await p.$('#btnSair') !== null, 'botao Sair presente');

  /* Contagens relativas ao que o banco de mentira tem. Fixar o numero na
     mao obriga a mexer no teste toda vez que o cenario muda, e foi o que
     quebrou seis verificacoes quando ampliei o mock. */
  const noBanco = await p.evaluate(() => window.__mockDb.materiais.length);
  const mats = await p.evaluate(() => DB.materiais.all().length);
  ok(mats === noBanco, 'a tela mostra exatamente os materiais do banco',
     mats + ' na tela, ' + noBanco + ' no banco');
  ok(mats !== 42, 'nao ha dados de demonstracao semeados por cima', mats);
  const desc = await p.evaluate(() => DB.materiais.all()[0].descricao);
  ok(desc === 'Cimento CP-II 50kg', 'conversao snake->camel correta', desc);
  const cfg = await p.evaluate(() => DB.config.get().empresa);
  ok(cfg === 'Construtora Teste Ltda', 'config veio da tabela empresas', cfg);
  const obrasBanco = await p.evaluate(() => window.__mockDb.obras.length);
  const semSeed = await p.evaluate(() => DB.obras.all().length);
  ok(semSeed === obrasBanco, 'nao semeou obras ficticias por cima', semSeed);

  console.log('\n=== C. ESCRITA: ENTRADA ===');
  const movBase = await p.evaluate(() => window.__mockDb.movimentacoes.length);
  let r = await p.evaluate(async () => {
    Mov.criar({ tipo:'entrada', materialId:'m1', materialDesc:'Cimento CP-II 50kg',
                unidade:'SC', quantidade:100, valorUnitario:40, obraId:null });
    await new Promise(r => setTimeout(r, 400));
    const ult = __mockDb.movimentacoes[__mockDb.movimentacoes.length - 1] || {};
    return { saldo: Stock.saldo('m1'), linhas: __mockDb.movimentacoes.length,
             col: Object.keys(ult).join(','), vt: ult.valor_total };
  });
  ok(r.saldo === 100, 'saldo local = 100 apos entrada', r.saldo);
  ok(r.linhas === movBase + 1, 'gravou 1 linha no banco', r.linhas);
  ok(/material_id/.test(r.col) && !/materialId/.test(r.col),
     'enviou colunas em snake_case', r.col.slice(0, 70));
  ok(Number(r.vt) === 4000, 'valor_total calculado pelo banco voltou', r.vt);

  console.log('\n=== D. ESCRITA: SAIDA E REGRA DE SALDO ===');
  r = await p.evaluate(async () => {
    Mov.criar({ tipo:'saida', materialId:'m1', materialDesc:'Cimento CP-II 50kg',
                unidade:'SC', quantidade:30, valorUnitario:40, obraId:'o1', destino:'Residencial Colina' });
    await new Promise(r => setTimeout(r, 400));
    return { saldo: Stock.saldo('m1'), linhas: __mockDb.movimentacoes.length };
  });
  ok(r.saldo === 70, 'saldo = 70 apos saida de 30', r.saldo);
  ok(r.linhas === movBase + 2, 'saida gravada', r.linhas);

  // saída acima do saldo: o banco recusa (P0001) e o espelho precisa voltar
  r = await p.evaluate(async () => {
    Mov.criar({ tipo:'saida', materialId:'m1', materialDesc:'Cimento CP-II 50kg',
                unidade:'SC', quantidade:9999, valorUnitario:40, obraId:'o1' });
    const logo = Stock.saldo('m1');
    await new Promise(r => setTimeout(r, 600));
    return { logo, depois: Stock.saldo('m1'), linhas: __mockDb.movimentacoes.length,
             toast: document.querySelector('.toasts')?.textContent || '' };
  });
  ok(r.depois === 70, 'ROLLBACK: saldo volta a 70 quando o banco recusa', r.depois);
  ok(r.linhas === movBase + 2, 'nada foi gravado no banco', r.linhas);
  ok(/insuficiente|Disponível/i.test(r.toast), 'usuario avisado da recusa', r.toast.trim().slice(0, 70));

  console.log('\n=== E. ENTREGA DIRETA NAO SOMA AO GALPAO ===');
  r = await p.evaluate(async () => {
    Mov.criar({ tipo:'entrada_direta', materialId:'m1', materialDesc:'Cimento CP-II 50kg',
                unidade:'SC', quantidade:500, valorUnitario:40, obraId:'o1' });
    await new Promise(r => setTimeout(r, 400));
    return { saldo: Stock.saldo('m1'), direto: Stock.diretos()['m1'] || 0 };
  });
  ok(r.saldo === 70, 'galpao continua 70 apos entrega direta de 500', r.saldo);
  ok(r.direto === 500, 'registrada como entrega direta', r.direto);

  console.log('\n=== F. DEVOLUCAO ACIMA DO ENVIADO ===');
  r = await p.evaluate(async () => {
    Mov.criar({ tipo:'devolucao', materialId:'m1', materialDesc:'Cimento CP-II 50kg',
                unidade:'SC', quantidade:999, valorUnitario:40, obraId:'o1' });
    await new Promise(r => setTimeout(r, 600));
    return { saldo: Stock.saldo('m1'), toast: document.querySelector('.toasts')?.textContent || '' };
  });
  ok(r.saldo === 70, 'devolucao impossivel revertida', r.saldo);
  ok(/obra/i.test(r.toast), 'mensagem explica o limite da obra', r.toast.trim().slice(-60));

  console.log('\n=== G. CADASTRO E EDICAO ===');
  r = await p.evaluate(async () => {
    DB.materiais.add({ codigo:'MAT-900', descricao:'Areia média', categoria:'Elétrica',
                       unidade:'M3', estoqueMinimo:5, estoqueIdeal:20, custoMedio:0, ativo:true });
    await new Promise(r => setTimeout(r, 400));
    const novo = __mockDb.materiais.find(x => x.codigo === 'MAT-900');
    return { existe: !!novo, id: novo?.id, emp: novo?.empresa_id,
             minimo: novo?.estoque_minimo, total: DB.materiais.all().length };
  });
  ok(r.existe, 'material novo chegou ao banco');
  ok(/^[0-9a-f-]{36}$/.test(r.id || ''), 'id uuid gerado no cliente', r.id);
  ok(r.emp === '11111111-1111-4111-8111-111111111111', 'empresa_id preenchido sozinho', r.emp);
  ok(Number(r.minimo) === 5, 'estoqueMinimo -> estoque_minimo', r.minimo);

  r = await p.evaluate(async () => {
    const mt = DB.materiais.all().find(x => x.codigo === 'MAT-900');
    DB.materiais.upd(mt.id, { estoqueMinimo: 12 });
    await new Promise(r => setTimeout(r, 400));
    return Number(__mockDb.materiais.find(x => x.codigo === 'MAT-900').estoque_minimo);
  });
  ok(r === 12, 'edicao persistida no banco', r);

  console.log('\n=== H. ROLLBACK DE EDICAO ===');
  r = await p.evaluate(async () => {
    const mt = DB.materiais.all().find(x => x.codigo === 'MAT-900');
    __mockFalhar('falha simulada de rede');
    DB.materiais.upd(mt.id, { descricao: 'NAO DEVE FICAR' });
    await new Promise(r => setTimeout(r, 600));
    return DB.materiais.get(mt.id).descricao;
  });
  ok(r === 'Areia média', 'edicao recusada volta ao valor anterior', r);

  console.log('\n=== I. CONFIGURACOES -> empresas + perfis ===');
  r = await p.evaluate(async () => {
    DB.config.set({ empresa:'Nova Razao Ltda', galpao:'Galpão Norte', usuario:'Ana S. Lima' });
    await new Promise(r => setTimeout(r, 500));
    return { nome: __mockDb.empresas[0].nome, galpao: __mockDb.empresas[0].galpao,
             perfil: __mockDb.perfis[0].nome };
  });
  ok(r.nome === 'Nova Razao Ltda', 'razao social gravada em empresas', r.nome);
  ok(r.galpao === 'Galpão Norte', 'galpao gravado em empresas', r.galpao);
  ok(r.perfil === 'Ana S. Lima', 'nome do usuario gravado em perfis', r.perfil);

  console.log('\n=== J. PERSISTENCIA APOS RECARREGAR ===');
  await p.reload({ waitUntil:'networkidle2' });
  await new Promise(r => setTimeout(r, 2500));
  r = await p.evaluate(() => ({ saldo: Stock.saldo('m1'), mats: DB.materiais.all().length,
                                emp: DB.config.get().empresa }));
  ok(r.saldo === 70, 'saldo recarregado do banco', r.saldo);
  ok(r.mats === noBanco + 1, 'materiais recarregados (os do banco + o criado aqui)', r.mats);
  ok(r.emp === 'Nova Razao Ltda', 'config recarregada', r.emp);
  await p.screenshot({ path:'pv/app-supabase.png' });

  console.log('\n=== K. TEMA SINCRONIZADO COM O PERFIL ===');
  r = await p.evaluate(async () => {
    Tema.definir('dark');
    await new Promise(r => setTimeout(r, 500));
    return { perfil: __mockDb.perfis[0].tema, html: document.documentElement.dataset.theme };
  });
  ok(r.html === 'dark', 'tema aplicado na tela', r.html);
  ok(r.perfil === 'dark', 'tema gravado em perfis.tema', r.perfil);

  console.log('\n=== M. NOTA FISCAL COM PRODUTOS (importacao de XML) ===');
  /* Reproduz o que o usuario fez e recebeu HTTP 400 duas vezes:
       POST /notas?select=*           -> o vetor "itens" nao e coluna de notas
       POST /movimentacoes?select=*   -> "nfId" virava "nf_id", coluna inexistente
     Os produtos moram em nota_itens, e a coluna da nota chama-se nota_id. */
  const nf = await p.evaluate(async () => {
    const forn = DB.fornecedores.all()[0];
    const nota = DB.notas.add({
      numero:'12345', serie:'1', chave:'NFE-CHAVE-TESTE', emissao:'2026-10-01',
      fornecedorId: forn.id, emitenteNome:'Casa do Construtor',
      valorTotal: 820, origem:'xml', destino:'galpao', obraId:null,
      itens:[{ codigo:'P1', descricao:'Cimento CP-II 50kg', qtd:20, unidade:'SC',
               valorUnit:41, valorTotal:820, ncm:'25232910', cfop:'5102',
               ean:'789', materialId:'m1' }]
    });
    Mov.criar({ tipo:'entrada', data:'2026-10-01', materialId:'m1',
                materialDesc:'Cimento CP-II 50kg', unidade:'SC', quantidade:20,
                valorUnitario:41, valorTotal:820, fornecedorId: forn.id,
                nfNumero:'12345', nfId: nota.id, origem:'Casa do Construtor',
                destino:'Galpão Central', obraId:null, observacao:'XML' });
    await new Promise(r => setTimeout(r, 1200));
    const linha = __mockDb.notas.find(n => n.numero === '12345');
    const mov   = __mockDb.movimentacoes.find(m => m.nf_numero === '12345');
    return {
      notaGravada: !!linha,
      colunasNota: Object.keys(linha || {}),
      itensNaTabelaFilha: (__mockDb.nota_itens || []).filter(i => i.nota_id === nota.id).length,
      itemDesc: (__mockDb.nota_itens || [])[0]?.descricao,
      movGravada: !!mov,
      movNotaId: mov ? mov.nota_id : null,
      idDaNota: nota.id,
      notaNaTela: DB.notas.all().some(n => n.numero === '12345')
    };
  });

  ok(nf.notaGravada, 'a nota e aceita pelo servidor (antes: HTTP 400)');
  ok(!nf.colunasNota.includes('itens'),
     'nao tenta gravar "itens" como coluna de notas', nf.colunasNota.join(','));
  ok(nf.itensNaTabelaFilha === 1,
     'o produto foi para nota_itens', 'linhas=' + nf.itensNaTabelaFilha);
  ok(nf.itemDesc === 'Cimento CP-II 50kg', 'o produto chegou inteiro', nf.itemDesc);
  ok(nf.movGravada, 'a movimentacao e aceita (antes: HTTP 400)');
  ok(nf.movNotaId === nf.idDaNota,
     'a movimentacao aponta para a nota em nota_id', 'nota_id=' + nf.movNotaId);
  ok(nf.notaNaTela, 'a nota aparece na tela');

  // recarregar prova que os produtos voltam do banco, e nao do cache da sessao
  await p.reload({ waitUntil:'networkidle2' });
  await new Promise(r => setTimeout(r, 2500));
  const volta = await p.evaluate(() => {
    const n = DB.notas.all().find(x => x.numero === '12345');
    return { itens: (n?.itens || []).length, qtd: n?.itens?.[0]?.qtd,
             vu: n?.itens?.[0]?.valorUnit };
  });
  ok(volta.itens === 1, 'ao recarregar, os produtos voltam do banco', 'itens=' + volta.itens);
  ok(volta.qtd === 20 && volta.vu === 41,
     'quantidade e valor unitario preservados', JSON.stringify(volta));

  console.log('\n=== L. SAIR ===');
  await p.evaluate(() => document.querySelector('#btnSair').click());
  await new Promise(r => setTimeout(r, 600));
  const temModal = await p.evaluate(() => /Sair do sistema/i.test(document.body.textContent));
  ok(temModal, 'pede confirmacao antes de sair');

  console.log('\n===================================');
  console.log(pass + ' passaram, ' + fail + ' falharam');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
