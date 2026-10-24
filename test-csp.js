const puppeteer=require('puppeteer'); const fs=require('fs');
const MOCK=fs.readFileSync('mock/supabase-fake.js','utf8');
const B='http://127.0.0.1:8099';
const CFG='assets/js/config.js', ORIG=fs.readFileSync(CFG,'utf8');
/* Restaurar SEMPRE: sem isto um teste interrompido deixa o config.js adulterado. */
['exit','SIGINT','SIGTERM'].forEach(ev =>
  process.on(ev, () => { try{ fs.writeFileSync(CFG,ORIG); }catch(e){} if(ev!=='exit') process.exit(1); }));

/* O teste NAO pode depender de o config.js vir preenchido ou com placeholder:
   ele mesmo monta cada estado. Antes isto estava implicito, e preencher o
   config.js de verdade quebrou o teste inteiro. */
const troca = (txt,url,key) => txt
  .replace(/^export const SUPABASE_URL\s*=.*$/m,  "export const SUPABASE_URL  = '"+url+"';")
  .replace(/^export const SUPABASE_ANON\s*=.*$/m, "export const SUPABASE_ANON = '"+key+"';");
const PROTO = troca(ORIG,'COLE_AQUI_SUA_PROJECT_URL','COLE_AQUI_SUA_ANON_KEY');
const DEMO  = troca(ORIG,'https://demo.supabase.co','chave-de-teste');
let pass=0,fail=0;
const ok=(c,l,x)=>{if(c){pass++;console.log('  OK   '+l);}else{fail++;console.log('  FALHA '+l+(x!==undefined?' -> '+x:''));}};
(async()=>{
const br=await puppeteer.launch({args:['--no-sandbox']});
const p=await br.newPage();
const viol=[], errs=[];
p.on('console',m=>{const t=m.text(); if(/Content Security Policy|Refused to/i.test(t)) viol.push(t.slice(0,150));});
p.on('pageerror',e=>errs.push(e.message.slice(0,110)));

console.log('=== CSP: APP ===');
/* A versao definitiva nao abre sem banco, entao esta secao entra pelo login
   contra o Supabase de mentira. O mock chega pela interceptacao de esm.sh,
   que e justamente a origem que o CSP precisa estar liberando. */
fs.writeFileSync(CFG, DEMO);
await p.setRequestInterception(true);
p.on('request',r=>{ r.url().includes('esm.sh')
  ? r.respond({status:200,contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:MOCK})
  : r.continue(); });
await p.goto(B+'/login.html',{waitUntil:'networkidle2'});
await new Promise(r=>setTimeout(r,900));
await p.type('#email','ana@teste.com');
await p.type('#senha','senha123');
await p.click('#btnEntrar');
await p.waitForNavigation({waitUntil:'networkidle2',timeout:15000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2500));
ok(p.url().includes('index.html'),'entrou no sistema sob CSP',p.url());
ok(await p.evaluate(()=>document.querySelector('#main')?.innerHTML.length>500),'app renderiza sob CSP');
ok(await p.evaluate(()=>typeof Tema==='object' && typeof Stories==='object'),'scripts embutidos executam');
ok(await p.evaluate(()=>getComputedStyle(document.body).fontFamily.includes('Inter')),'fonte externa carrega');
await p.evaluate(()=>Tema.definir('dark')); await new Promise(r=>setTimeout(r,300));
ok(await p.evaluate(()=>getComputedStyle(document.body).backgroundColor)==='rgb(15, 23, 32)','tema escuro aplica');
await p.evaluate(()=>document.querySelector('#storiesStrip .story').click());
await new Promise(r=>setTimeout(r,600));
ok(await p.$('.stv')!==null,'stories abrem');
await p.keyboard.press('Escape');

console.log('\n=== CSP: LOGIN + SDK ===');
/* agora sim com credenciais, para o SDK ser buscado de verdade */
fs.writeFileSync(CFG, DEMO);
/* Contexto proprio: a secao anterior deixou sessao aberta, e no mesmo
   contexto o login.html redirigiria direto para o sistema. */
const ctx2=await br.createBrowserContext();
const p2=await ctx2.newPage();
await p2.setRequestInterception(true);
p2.on('request',r=>{ r.url().includes('esm.sh')
  ? r.respond({status:200,contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:MOCK})
  : r.continue(); });
p2.on('console',m=>{const t=m.text(); if(/Content Security Policy|Refused to/i.test(t)) viol.push('[login] '+t.slice(0,150));});
await p2.goto(B+'/login.html',{waitUntil:'networkidle2'});
await new Promise(r=>setTimeout(r,1500));
ok(await p2.$('#telaLogin')!==null,'login renderiza sob CSP');
ok(await p2.evaluate(()=>typeof window.__mockDb)==='object','modulo do SDK carrega (esm.sh liberado)');

console.log('\n=== CSP x SERVICE WORKER ===');
/* O service worker refaz os pedidos de CDN com fetch(), e fetch() dentro do
   SW é julgado como connect-src — não como style-src/font-src. Isto já
   derrubou o estilo do site inteiro em produção. Conferimos de forma
   estática, porque o navegador só reclama quando o SW está ativo e no teste
   ele nem sempre assume a tempo. */
const CSP = fs.readFileSync(__dirname + '/_headers', 'utf8');
/* Pegar a DIRETIVA, não a palavra solta: os comentários do _headers também
   citam "connect-src" e a busca ingênua casava com o texto explicativo. */
const linhaCSP = (CSP.split('\n').find(l => /^\s*Content-Security-Policy:/.test(l)) || '');
const connect  = (/connect-src([^;]*)/.exec(linhaCSP) || [,''])[1];
const CDNS = (fs.readFileSync(__dirname + '/sw.js','utf8')
  .match(/fonts\\\.\(googleapis\|gstatic\)\\\.com\|cdnjs\\\.cloudflare\\\.com/) )
  ? ['fonts.googleapis.com','fonts.gstatic.com','cdnjs.cloudflare.com'] : [];

CDNS.forEach(d => ok(connect.includes(d),
  'connect-src libera ' + d + ' (o SW busca de lá)',
  'falta em connect-src: ' + d));

ok(!/connect-src[^;]*\*(?!\.supabase)/.test(CSP) || /\*\.supabase\.co/.test(connect),
   'connect-src nao usa curinga aberto');

console.log('\n=== CONFIG DE PUBLICACAO (Cloudflare Worker) ===');
/* O site roda como Worker, nao como Pages. Derrubou a producao uma vez:
   regras no _redirects apontando para caminhos .html entram em ciclo com o
   roteamento da Cloudflare e TODA pagina HTML passa a responder 500. */
try {
  const bruto = fs.readFileSync(__dirname + '/wrangler.jsonc','utf8');
  // JSONC -> JSON: remove comentarios de linha que nao estejam dentro de string.
  const limpo = bruto.split('\n')
    .map(l => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  const w = JSON.parse(limpo);
  ok(w.name === 'obrastock',
     'wrangler.jsonc: nome bate com o Worker publicado',
     'nome="' + w.name + '" (esperado "obrastock"; nome errado cria OUTRO Worker)');
  ok(w.assets && w.assets.html_handling === 'none',
     'html_handling = none (o app usa URLs com .html explicito)',
     'html_handling=' + (w.assets && w.assets.html_handling));
  ok(w.assets && w.assets.not_found_handling === 'single-page-application',
     'not_found_handling cobre a raiz "/"',
     'sem fallback: com html_handling=none a raiz devolve 404');
} catch (e) {
  ok(false, 'wrangler.jsonc valido', String(e.message));
}

const red = fs.readFileSync(__dirname + '/_redirects','utf8');
const regras = red.split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));
ok(regras.length === 0,
   '_redirects sem regras (evita o ciclo que gerou erro 500)',
   'regra(s) ativa(s): ' + regras.join(' | '));
regras.forEach(r => ok(!/\.html|\/index/.test(r),
   '_redirects: regra sem destino .html',
   'regra com destino .html entra em ciclo na Cloudflare: ' + r));

const ign = fs.readFileSync(__dirname + '/.assetsignore','utf8');
ok(/^supabase\/$/m.test(ign), '.assetsignore nao publica supabase/');
ok(/^test-\*\.js$/m.test(ign), '.assetsignore nao publica os testes');

console.log('\n=== CREDENCIAIS (assets/js/config.js) ===');
/* Este arquivo quase derrubou a producao: a copia do workspace ficou com os
   marcadores COLE_AQUI enquanto a publicada estava preenchida. Subir a pasta
   assets/ por cima teria trocado as credenciais boas por placeholders. */
const cfg = ORIG;   // o conteudo real entregue, nao o que o teste escreveu
const leia = n => (new RegExp("^export const " + n + "\\s*=\\s*'([^']*)'", 'm').exec(cfg) || [,''])[1];
const sbUrl = leia('SUPABASE_URL'), sbKey = leia('SUPABASE_ANON');

/* Buscar "COLE_AQUI" no arquivo inteiro da falso positivo: as linhas 49-50
   usam esse texto como logica (startsWith). Vale so o valor das constantes. */
ok(sbUrl && !sbUrl.startsWith('COLE_AQUI'),
   'SUPABASE_URL preenchido', 'ainda e placeholder: publicar quebra o site');
ok(sbKey && !sbKey.startsWith('COLE_AQUI'),
   'SUPABASE_ANON preenchido', 'ainda e placeholder: publicar quebra o site');

try {
  const corpo = JSON.parse(Buffer.from(sbKey.split('.')[1], 'base64url').toString());
  /* Grep por "service_role" nao serve: a palavra aparece nos comentarios de
     aviso. O unico jeito honesto e decodificar o payload do JWT. */
  ok(corpo.role === 'anon',
     'a chave e a publica (anon), nunca service_role',
     'role=' + corpo.role + ' — ESTA CHAVE IGNORA TODA A SEGURANCA (RLS)');
  ok(sbUrl.includes(corpo.ref),
     'a chave pertence ao projeto da URL',
     'URL aponta para ' + sbUrl + ' mas a chave e do projeto ' + corpo.ref);
} catch (e) {
  ok(false, 'SUPABASE_ANON e um JWT valido', String(e.message));
}

console.log('\n=== VIOLACOES ===');
ok(viol.length===0,'nenhuma violacao de CSP', viol.slice(0,3).join('\n        '));
ok(errs.length===0,'nenhum erro de JS', errs.slice(0,2).join(' | '));
console.log('\n'+pass+' passaram, '+fail+' falharam');
await br.close(); process.exit(fail?1:0);
})();
