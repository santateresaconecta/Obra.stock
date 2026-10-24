/* =============================================================================
   PIX copia e cola — do cálculo ao que o cliente vê
   =============================================================================
   O BR Code é uma string com um CRC-16 no fim. Se um caractere estiver
   errado, o CRC não fecha e o aplicativo do banco recusa tudo — sem dizer
   onde está o erro. Então o teste começa pelo gabarito:

     o exemplo publicado no manual do BACEN (chave aleatória, sem valor,
     txid ***, "Fulano de Tal" em BRASILIA) tem CRC 1D3D.

   Se o nosso cálculo reproduz esse valor, o algoritmo está certo. Depois
   disso o teste segue pela interface: abre "Meu plano" como cliente e
   confere o código que aparece para copiar.
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
  await p.setViewport({ width: 1100, height: 950 });
  const erros = [];
  p.on('pageerror', e => erros.push(e.message.slice(0, 140)));

  await prepararMock(p, MOCK, DEMO_DEV);
  ok(await entrar(p, B), 'entrou no sistema');

  await p.evaluate(() => {
    window.__recusas = [];
    const orig = window.Toast && window.Toast.err;
    if (orig) window.Toast.err = function (t, m) {
      window.__recusas.push(t + ': ' + (m || '')); return orig.apply(this, arguments);
    };
  });

  /* ============================================================
     A) O gabarito do BACEN
     ============================================================ */
  console.log('\n=== A) CONFERENCIA CONTRA O MANUAL DO BACEN ===');
  ok(await p.evaluate(() => typeof window.Pix === 'object' && !!window.Pix),
     'o modulo de PIX foi carregado pela ponte');

  const oficial = await p.evaluate(() => {
    const semCrc =
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000' +
      '52040000' + '5303986' + '5802BR' + '5913Fulano de Tal' + '6008BRASILIA' +
      '62070503***' + '6304';
    return { calculado: window.Pix.crc16(semCrc), payload: semCrc };
  });
  ok(oficial.calculado === '1D3D',
     'o CRC do exemplo oficial bate (1D3D)', oficial.calculado);

  /* Trocar UM caractere tem que mudar o CRC — senao o checksum nao protege nada */
  const alterado = await p.evaluate(s => window.Pix.crc16(s.replace('BRASILIA', 'BRASILIB')),
                                    oficial.payload);
  ok(alterado !== '1D3D', 'mudar um caractere muda o CRC', alterado);

  /* ============================================================
     B) O codigo gerado para uma cobranca
     ============================================================ */
  console.log('\n=== B) CODIGO DE UMA COBRANCA ===');
  const r = await p.evaluate(() => {
    const codigo = window.Pix.gerarBRCode({
      chave: '492f755b-af4b-41f9-8725-ea2e31f87fde',
      nome: 'Paulo Lemos', cidade: 'Santa Maria de Jetiba',
      valor: 350, txid: window.Pix.txidDaCobranca('2026-10-01', 'abcd1234-0000-0000-0000-000000000000')
    });
    return { codigo, lido: window.Pix.lerBRCode(codigo) };
  });
  ok(r.lido.crcOk, 'o CRC do codigo gerado confere', r.codigo.slice(-4));
  ok(r.lido.campos['53'] === '986', 'moeda e real (986)', r.lido.campos['53']);
  ok(r.lido.campos['54'] === '350.00', 'valor com ponto e duas casas', r.lido.campos['54']);
  ok(r.lido.campos['58'] === 'BR', 'pais BR', r.lido.campos['58']);
  ok(r.lido.campos['26'].includes('br.gov.bcb.pix'), 'identificador do PIX presente');
  ok(r.lido.campos['26'].includes('492f755b-af4b-41f9-8725-ea2e31f87fde'), 'a chave esta no codigo');

  /* Limites do padrao: nome 25, cidade 15, sem acento */
  ok(r.lido.campos['60'].length <= 15, 'cidade cortada em 15 caracteres',
     r.lido.campos['60'] + ' (' + r.lido.campos['60'].length + ')');
  ok(!/[^\x20-\x7E]/.test(r.codigo), 'o codigo e todo ASCII — acento quebraria o CRC no banco');

  const semAcento = await p.evaluate(() => window.Pix.normalizar('José Antônio Conceição', 25));
  ok(semAcento === 'JOSE ANTONIO CONCEICAO', 'acentos sao convertidos, nao recusados', semAcento);

  const txid = await p.evaluate(() =>
    window.Pix.txidDaCobranca('2026-10-01', 'abcd1234-0000-0000-0000-000000000000'));
  ok(/^[A-Za-z0-9]{1,25}$/.test(txid), 'o txid so tem letras e numeros, ate 25', txid);
  ok(txid.includes('202610'), 'o txid identifica a competencia, para conciliar o extrato', txid);

  /* Sem valor, o pagador digita o quanto quer — tem que continuar valido */
  const semValor = await p.evaluate(() => {
    const c = window.Pix.gerarBRCode({ chave: 'x@y.com', nome: 'Teste', cidade: 'Vitoria' });
    return window.Pix.lerBRCode(c);
  });
  ok(semValor.crcOk && semValor.campos['54'] === undefined,
     'codigo sem valor tambem e valido', JSON.stringify(semValor.campos['54']));

  /* ============================================================
     C) Falta de configuracao nao pode gerar codigo invalido
     ============================================================ */
  console.log('\n=== C) O QUE O SISTEMA SE RECUSA A GERAR ===');
  for (const [faltando, args] of [
    ['chave',  { nome: 'Teste', cidade: 'Vitoria' }],
    ['nome',   { chave: 'x@y.com', cidade: 'Vitoria' }],
    ['cidade', { chave: 'x@y.com', nome: 'Teste' }]
  ]) {
    const err = await p.evaluate(a => {
      try { window.Pix.gerarBRCode(a); return null; } catch (e) { return e.message; }
    }, args);
    ok(err !== null, 'sem ' + faltando + ', recusa em vez de gerar codigo quebrado', err);
  }

  /* ============================================================
     D) A tela do cliente
     ============================================================ */
  console.log('\n=== D) O QUE O CLIENTE VE ===');

  /* Primeiro o estado real de quem acabou de instalar: sem nome cadastrado. */
  await p.evaluate(() => {
    window.__mockDb.cobrancas.push({
      id: 'cbPix', empresa_id: window.__mockDb.perfis[0].empresa_id,
      competencia: '2026-10-01', descricao: 'Sustentação mensal', valor: 350,
      vencimento: '2026-10-10', pago_em: null, metodo: null
    });
  });
  await p.evaluate(() => App.go('contrato'));
  await esperar(2000);

  let corpo = await p.evaluate(() => document.body.textContent);
  ok(/dados de recebimento ainda não foram preenchidos/i.test(corpo),
     'sem o nome do recebedor, avisa em vez de mostrar codigo invalido');
  ok(!(await p.$('#pxCodigo')), 'e nao mostra campo de codigo nenhum');

  /* Agora com tudo preenchido, como fica para o cliente. */
  await p.evaluate(() => { window.__mockDb.cobranca_config[0].beneficiario = 'Paulo Lemos'; });
  await p.evaluate(() => App.go('dashboard'));
  await esperar(600);
  await p.evaluate(() => App.go('contrato'));
  await esperar(2000);

  const codigoTela = await p.$eval('#pxCodigo', e => e.value).catch(() => null);
  ok(codigoTela !== null, 'o PIX copia e cola aparece para o cliente');
  const conf = await p.evaluate(c => window.Pix.lerBRCode(c), codigoTela || '');
  ok(conf.crcOk, 'o codigo mostrado na tela tem CRC valido');
  ok(conf.campos['54'] === '350.00', 'com o valor exato da cobranca', conf.campos['54']);

  corpo = await p.evaluate(() => document.body.textContent);
  ok(/R\$\s*350,00/.test(corpo), 'o valor aparece em reais na tela');
  ok(/vence/i.test(corpo), 'mostra o vencimento');
  ok(await p.$('#pxCopiar') !== null, 'tem botao de copiar');

  /* Cobranca paga: o bloco tem que sumir, nao ficar cobrando quem ja pagou */
  await p.evaluate(() => {
    window.__mockDb.cobrancas.forEach(c => { c.pago_em = '2026-10-05'; c.metodo = 'PIX'; });
  });
  await p.evaluate(() => App.go('dashboard'));
  await esperar(600);
  await p.evaluate(() => App.go('contrato'));
  await esperar(2000);
  ok(!(await p.$('#pxCodigo')), 'depois de pago, o bloco de pagamento some');

  /* ============================================================
     E) A tela do desenvolvedor
     ============================================================ */
  console.log('\n=== E) DADOS DE RECEBIMENTO (DEV) ===');
  await p.evaluate(() => App.go('cobranca'));
  await esperar(1500);
  ok(await p.$('#cbReceb') !== null, 'botao "Dados de recebimento" existe');
  await p.click('#cbReceb');
  await esperar(1200);
  ok(await p.$('#rcChave') !== null, 'o formulario abriu');
  const chaveAtual = await p.$eval('#rcChave', e => e.value);
  ok(chaveAtual === '492f755b-af4b-41f9-8725-ea2e31f87fde', 'trouxe a chave cadastrada', chaveAtual);

  const prevInicial = await p.$eval('#rcPreview', e => e.textContent);
  ok(/350/.test(prevInicial), 'mostra uma previa do codigo antes de salvar');

  /* Apagar o nome tem que derrubar a previa na hora, nao no cliente */
  await p.evaluate(() => { const e = document.getElementById('rcNome');
                           e.value = ''; e.dispatchEvent(new Event('input')); });
  await esperar(500);
  const prevVazio = await p.$eval('#rcPreview', e => e.textContent);
  ok(/nome do recebedor/i.test(prevVazio), 'sem nome, a previa avisa na hora', prevVazio.slice(0, 60));

  await p.evaluate(() => { const e = document.getElementById('rcNome');
                           e.value = 'Paulo R Lemos'; e.dispatchEvent(new Event('input')); });
  await esperar(500);
  await p.evaluate(() => { window.__recusas = []; });
  await p.click('#rcSalvar');
  await esperar(1500);
  const salvo = await p.evaluate(() => window.__mockDb.cobranca_config[0]);
  ok(salvo && salvo.beneficiario === 'Paulo R Lemos', 'o nome foi gravado', salvo && salvo.beneficiario);

  ok(erros.length === 0, 'sem erro de JavaScript', erros.slice(0, 2).join(' | '));

  console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
