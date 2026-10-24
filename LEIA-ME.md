# ObraStock — Gestão de Estoque para Construtoras

Sistema em produção. Dados no **Supabase**, hospedagem no **Cloudflare**.

**v2.0** — versão definitiva. Autenticação por usuário, dados no banco,
modo escuro, foto do material e alertas de saldo baixo em formato de
stories.

## Arquivos

```
index.html              Aplicação (HTML + CSS + JS)
login.html              Entrada, recuperação e troca de senha
assets/js/config.js     Endereço e chave pública do projeto Supabase
assets/js/auth.js       Sessão, perfil e preferências do usuário
assets/js/guard.js      Guarda de rota: exige login antes de liberar a tela
assets/js/data.js       Camada de dados sobre o Supabase
assets/js/fotos.js      Foto do material (reduz e envia ao Storage)
assets/js/gestao.js     Usuários, contrato e cobrança
supabase/               Scripts SQL do banco
manifest.webmanifest    Metadados do PWA
sw.js                   Service Worker (cache da interface)
icons/                  Ícones do app
exemplo-nfe.xml         NF-e de teste para a importação de XML
```

## Onde ficam os dados

Tudo o que o usuário registra vai para o Supabase na hora. **Nenhum dado do
negócio fica guardado no navegador.**

O `localStorage` é usado só para quatro coisas, todas de conveniência:

| chave | para quê | o que acontece se apagar |
|---|---|---|
| sessão do Supabase | manter o login entre visitas | pede login de novo |
| `obrastock:tema` | claro / escuro / automático | volta ao automático |
| `obrastock:storiesVistos` | não repetir o alerta já visto hoje | os alertas reaparecem |
| `obrastock:instalado`, `obrastock:dica-ios` | dicas de instalação do app | a dica reaparece |

Nenhuma delas guarda material, obra, movimentação ou nota fiscal.

## Sem configuração, não abre

Se `assets/js/config.js` estiver sem as credenciais, o sistema mostra
"Sistema não configurado" e **não** libera a tela. É proposital: um sistema
que aceita lançamentos sem banco é pior do que um que não abre — o
almoxarife registraria a saída, veria o estoque baixar e o dado morreria
naquele aparelho.

## Banco de dados

Rode no SQL Editor do Supabase, nesta ordem:

```
supabase/schema.sql           estrutura, políticas de acesso e views
supabase/dev-e-cobranca.sql   acesso de desenvolvedor, contrato e cobrança
supabase/foto-materiais.sql   coluna da foto e balde de arquivos
supabase/ping.sql             mantém o projeto ativo no plano gratuito
```

`supabase/verificar.sql` confere se está tudo no lugar.

## Desenvolvimento

```bash
python3 -m http.server 8080
# acesse http://localhost:8080
```

Os módulos são ES Modules: abrir `index.html` por duplo clique (`file://`)
não funciona, precisa do servidor.

## Testes

```bash
npm i puppeteer
node test-auth.js      node test-dados.js     node test-etapa5.js
node test-etapa7.js    node test-xml.js       node test-obra.js
node test-fotos.js     node test-csp.js       node test-falsoalarme.js
```
