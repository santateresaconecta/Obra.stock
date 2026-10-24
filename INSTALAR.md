# Instalar o ObraStock

Guia único. Siga na ordem — alguns scripts dependem dos anteriores.

Se o seu sistema já está no ar e você só quer republicar, vá direto ao
**passo 4**.

---

# Passo 1 — Banco de dados

No Supabase: **SQL Editor → New query**, cole cada arquivo e clique em
**Run**. Um de cada vez, **nesta ordem**:

| # | arquivo | o que cria |
|---|---|---|
| 1 | `supabase/schema.sql` | tabelas, regras de acesso e views |
| 2 | `supabase/dev-e-cobranca.sql` | acesso de desenvolvedor, contratos, cobranças |
| 3 | `supabase/foto-materiais.sql` | coluna da foto e o balde de arquivos |
| 4 | `supabase/novo-cliente.sql` | cadastro de empresa + contrato numa tacada |
| 5 | `supabase/cobranca-automatica.sql` | geração da mensalidade todo dia 1º |
| 6 | `supabase/pix.sql` | dados de recebimento (sua chave PIX) |
| 7 | `supabase/ping.sql` | mantém o projeto acordado no plano gratuito |

**A ordem importa.** Do 3 em diante, todos dependem de funções criadas pelo
`dev-e-cobranca.sql`. Rodar fora de ordem dá erro de função inexistente.

Todos são reexecutáveis: rodar duas vezes não estraga nada. Cada um imprime
uma conferência no fim — leia, é ela que diz se funcionou.

## Duas observações

**No item 5**, se a conferência disser *"pg_cron DESLIGADO"*, ligue a
extensão em **Database → Extensions** (procure `pg_cron`) e rode o script de
novo. Sem ela, a mensalidade não é gerada sozinha — mas o botão **Gerar
todos**, na tela de Cobrança, resolve o mês.

**No item 6**, a conferência vai dizer que falta o nome do recebedor. É
esperado: você preenche depois, pela tela (passo 6 deste guia).

---

# Passo 2 — Edge Function

É o que cria usuários com segurança. A chave `service_role` fica no
servidor; o navegador nunca a vê.

**Edge Functions → Deploy a new function → Via Editor**

- Nome exato: `admin-usuarios`
- Cole o conteúdo de `supabase/functions/admin-usuarios/index.ts`
- Deixe **Enforce JWT** ligado
- **Deploy**

Recarregue a página e confira se o código está mesmo lá — há relatos de
deploy que reverte sem avisar. Procure por `generateLink`.

---

# Passo 3 — Credenciais

O arquivo `assets/js/config.js` já vem preenchido com o endereço e a chave
pública do projeto. Confira duas linhas:

```js
export const SUPABASE_URL  = 'https://....supabase.co';
export const DEVS = ['seu-email@exemplo.com'];
```

`DEVS` decide quais menus aparecem para você. Quem realmente bloqueia é o
banco — a tabela `desenvolvedores` e a Edge Function. Mesmo que alguém edite
este arquivo no próprio navegador, o servidor recusa.

A chave `anon` é pública por design: quem protege os dados é a RLS, já
validada. **Nunca** coloque aqui a chave `service_role`.

---

# Passo 4 — Publicar

O site roda no **Cloudflare Workers** (static assets), servido a partir da
raiz do repositório, sem etapa de build. O `wrangler.jsonc` já está
configurado:

- `html_handling: "none"` — serve `login.html` como está;
- `not_found_handling: "single-page-application"`.

**Não mexa nesses dois.** Foi uma combinação específica deles que causou erro
500 em todo HTML do site, e levou um bom tempo para ser encontrada.

Envie os arquivos ao GitHub e a Cloudflare publica. Se não publicar sozinha,
abra **Workers & Pages → (seu projeto) → Deployments → Create deployment**.

## Confirme que publicou, sempre

Enviar ao GitHub **não é** publicar. Já aconteceu duas vezes de o arquivo
certo estar no repositório e o site continuar servindo o antigo. O teste
leva dez segundos:

```
https://SEU-SITE.workers.dev/sw.js
```

A sétima linha mostra a versão. Se não for a que você acabou de enviar, o
problema é deploy, não código.

Pode ser preciso **Ctrl+F5** na primeira vez: o navegador guarda a interface
até o service worker trocar de versão.

---

# Passo 5 — Manter o projeto acordado

**Esta parte não dá para fazer arrastando arquivo.** O GitHub não aceita
upload de pastas que começam com ponto.

No GitHub: **Add file → Create new file**, e digite o caminho completo (as
barras criam as pastas):

```
.github/workflows/manter-supabase-ativo.yml
```

Cole o conteúdo do arquivo que está no pacote e commit.

**Por que importa:** o Supabase gratuito pausa o projeto após 7 dias sem
nenhuma consulta. Projeto pausado é sistema fora do ar — e agendador parado,
ou seja, a mensalidade do dia 1º não é gerada. Com o cliente usando todo dia
não acontece; num recesso de fim de ano, acontece.

---

# Passo 6 — Primeiro uso

1. **Cobrança → Dados de recebimento** — preencha o nome do recebedor (o que
   aparece na sua conta). Sem ele, a tela de pagamento do cliente não mostra
   o PIX. A prévia ao lado mostra o código enquanto você digita.

2. **Cobrança → Novo cliente** — empresa, contrato e o acesso do responsável
   num formulário só. Ao salvar, aparece o **link de primeiro acesso** para
   mandar por WhatsApp; a pessoa abre e escolhe a própria senha.

3. **Cobrança → Gerar todos** — gera a mensalidade do mês corrente.

---

# Conferir se está tudo de pé

Rode `supabase/verificar.sql` no SQL Editor: ele checa tabelas, políticas e
funções.

Para testar a interface na sua máquina:

```bash
npm i puppeteer
python3 -m http.server 8080      # em outro terminal
node test-auth.js  node test-dados.js   node test-etapa5.js
node test-etapa7.js  node test-xml.js   node test-obra.js
node test-fotos.js   node test-cliente.js  node test-pix.js
node test-falsoalarme.js                 # precisa de cenários em /tmp/cen
node serve-headers.js &                  # porta 8099, para o test-csp
node test-csp.js
```

Os testes usam um Supabase de mentira: não tocam no seu banco.

---

# Se algo der errado

| sintoma | onde olhar |
|---|---|
| tela branca ou "Sistema não configurado" | `assets/js/config.js` sem credenciais |
| "empresa sem contrato" ao gerar cobrança | Cobrança → escolha a empresa → Contrato |
| o cliente não vê o PIX | falta o nome em Dados de recebimento |
| link de acesso expirou | Usuários → a pessoa → Gerar link de acesso |
| mudança não aparece no site | é deploy: confira `/sw.js` (passo 4) |
| sistema sumiu do ar | projeto pausado no Supabase (passo 5) |

Os guias de cada funcionalidade estão em `docs/`.
