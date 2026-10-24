/* =============================================================================
   Apoio aos testes de navegador — estado das credenciais
   =============================================================================
   Vários testes exercitam o "modo protótipo" (sem credenciais) e, durante muito
   tempo, funcionaram só porque o assets/js/config.js entregue estava com os
   marcadores COLE_AQUI. Isso era uma dependência invisível: no dia em que o
   config.js foi preenchido com as credenciais reais — que é como ele precisa
   ficar para ser publicado — cinco testes quebraram de uma vez.

   Pior: um dos testes chegava a AFIRMAR que os placeholders estavam lá, o que
   na prática proibia o arquivo de ficar pronto para produção.

   Aqui cada teste passa a declarar o estado que quer, servindo o config.js por
   interceptação em vez de depender do que está em disco. Interceptar é melhor
   que reescrever o arquivo: não corre o risco de deixar o repositório sujo se
   o teste for interrompido, e não é mascarado por cache nem pelo service
   worker (que já atrapalhou edições diretas em disco).
============================================================================= */
const fs = require('fs');

const BASE = fs.readFileSync(__dirname + '/assets/js/config.js', 'utf8');

/** Devolve o config.js com outra URL e outra chave. */
function versao(url, chave) {
  return BASE
    .replace(/^export const SUPABASE_URL\s*=.*$/m,  "export const SUPABASE_URL  = '" + url + "';")
    .replace(/^export const SUPABASE_ANON\s*=.*$/m, "export const SUPABASE_ANON = '" + chave + "';");
}

/** Sem credenciais. A partir da versão definitiva isto NÃO abre mais o
    sistema: o guard bloqueia a tela com "Sistema não configurado". Serve
    para testar justamente esse bloqueio. */
const SEM_CREDENCIAIS = versao('COLE_AQUI_SUA_PROJECT_URL', 'COLE_AQUI_SUA_ANON_KEY');

/** Credenciais de mentira, só para o fluxo de login rodar contra o mock. */
const DEMO = versao('https://demo.supabase.co', 'chave-de-teste');

/** Igual ao DEMO, mas com o usuário do mock na lista de desenvolvedores.
    Sem isto as telas de dev (Usuários, Cobrança) aparecem bloqueadas no
    teste, porque a lista DEVS do config real tem outro e-mail. */
const DEMO_DEV = DEMO.replace(/^export const DEVS\s*=.*$/m,
  "export const DEVS = ['ana@teste.com'];");

/**
 * Faz a página receber o `corpo` informado no lugar do config.js real.
 * Precisa ser chamado ANTES do page.goto.
 */
async function servirConfig(page, corpo) {
  /* O service worker do index.html intercepta assets/js/*.js e pode responder
     do cache — nesse caso NAO ha requisicao de rede e a interceptacao abaixo
     nunca e consultada. Foi o que fez a secao do app continuar falhando
     enquanto a do login ja passava. Desligar o SW nestas paginas resolve. */
  if (typeof page.setBypassServiceWorker === 'function') {
    await page.setBypassServiceWorker(true);
  }
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().includes('/assets/js/config.js')) {
      // Cabeçalhos importam: módulo ES interceptado precisa de CORS liberado,
      // e sem no-store o service worker devolve a versão antiga.
      return req.respond({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        body: corpo
      });
    }
    req.continue();
  });
}

/**
 * Prepara a página para rodar contra o Supabase de mentira: serve o config
 * de demonstração, entrega o mock no lugar do SDK e corta o service worker.
 * Precisa ser chamado ANTES do page.goto.
 */
async function prepararMock(page, mock, config) {
  if (typeof page.setBypassServiceWorker === 'function')
    await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/assets/js/config.js'))
      return req.respond({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        body: config || DEMO });
    if (u.endsWith('/sw.js'))
      return req.respond({ status: 404, contentType: 'text/plain', body: '' });
    if (u.includes('esm.sh'))
      return req.respond({
        status: 200, contentType: 'application/javascript',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: mock });
    req.continue();
  });
}

/** Faz login e devolve true se chegou ao sistema. */
async function entrar(page, base) {
  await page.goto(base + '/login.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 800));
  if (await page.$('#email')) {
    await page.type('#email', 'ana@teste.com');
    await page.type('#senha', 'senha123');
    await page.click('#btnEntrar');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 2500));
  return page.url().includes('index.html');
}

module.exports = { versao, SEM_CREDENCIAIS, DEMO, DEMO_DEV, servirConfig, prepararMock, entrar };
