/* =============================================================================
   ObraStock — o aviso "Não foi possível iniciar o sistema" só pode aparecer
   quando houver falha de verdade.
   =============================================================================
   Motivo deste arquivo: em produção o aviso apareceu permanentemente sobre um
   sistema que estava funcionando. A causa foi um index.html novo publicado com
   um assets/js/guard.js antigo — o guard carregava, mas não conhecia o sinal
   que a rede de segurança espera. Como o arquivo existia, limpar o cache não
   adiantava nada.

   Cenários (servidos de /tmp/cen por um servidor estático):
     ok    — guard sinaliza                 -> sem aviso
     skew  — guard carrega mas NÃO sinaliza -> sem aviso (+ alerta no console)
     falta — assets/js ausente              -> AVISO, e por cima de tudo
============================================================================= */
const puppeteer = require('puppeteer');

const BASE = process.env.BASE || 'http://127.0.0.1:8077';
let pass = 0, fail = 0;
const ok = (c, nome, det) => {
  if (c) { pass++; console.log('  OK   ' + nome); }
  else   { fail++; console.log('  FALHA ' + nome + (det ? ' -> ' + det : '')); }
};

/** Abre um cenário, espera a rede de segurança (6s) agir e relata o estado. */
async function cenario(br, nome) {
  const pg = await br.newPage();
  const avisos = [];
  // Capturar todos os tipos: o nome do tipo de console.warn já mudou entre
  // versões do Puppeteer ('warning' x 'warn') e filtrar aqui esconde a mensagem.
  pg.on('console', m => avisos.push(m.text()));
  await pg.goto(BASE + '/' + nome + '/index.html', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 8000));   // 6s do failsafe + folga

  const r = await pg.evaluate(() => {
    const alerta = document.querySelector('[role="alert"]');
    // Nada de offsetParent: em elemento position:fixed ele é SEMPRE null, o que
    // dava "aviso ausente" mesmo com o aviso na tela. Vale a área ocupada.
    const r = alerta && alerta.getBoundingClientRect();
    const visivel = !!r && r.width > 0 && r.height > 0 &&
                    getComputedStyle(alerta).visibility !== 'hidden';
    // Saber o texto não basta: innerText devolve também o que está por baixo.
    // Só elementFromPoint prova que o aviso cobre a tela.
    const centro = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    let naFrente = false;
    for (let n = centro; n; n = n.parentElement)
      if (n.getAttribute && n.getAttribute('role') === 'alert') { naFrente = true; break; }
    return {
      temAviso: visivel,
      naFrente,
      telaVisivel: getComputedStyle(document.documentElement).visibility !== 'hidden'
    };
  });
  await pg.close();
  return { ...r, avisos };
}

(async () => {
  const br = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  console.log('\n=== guard saudavel (sinaliza) ===');
  let r = await cenario(br, 'ok');
  ok(!r.temAviso, 'nenhum aviso sobre app saudavel', 'aviso apareceu sem motivo');
  ok(r.telaVisivel, 'tela visivel');

  console.log('\n=== versoes desencontradas (guard antigo, sem o sinal) ===');
  r = await cenario(br, 'skew');
  ok(!r.temAviso, 'NAO acusa falha: o arquivo existe, o sistema funciona',
     'falso alarme — foi exatamente o bug relatado em producao');
  ok(r.telaVisivel, 'tela visivel');
  ok(r.avisos.some(t => /versões diferentes|versoes diferentes/i.test(t)),
     'deixa alerta no console explicando o descasamento',
     'console: ' + JSON.stringify(r.avisos.slice(0, 2)));

  console.log('\n=== falha real (assets/js ausente) ===');
  r = await cenario(br, 'falta');
  ok(r.temAviso, 'acusa a falha', 'aviso nao apareceu quando devia');
  ok(r.naFrente, 'o aviso esta na frente de tudo', 'esta atras do conteudo');

  console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
  await br.close();
  process.exit(fail ? 1 : 0);
})();
